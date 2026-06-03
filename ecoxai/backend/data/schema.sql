-- PostgreSQL Schema for Agent Execution Observability
-- Auto-created by databaseManager.js on first initialization

-- ============================================================================
-- CORE APPLICATION STATE TABLES (Phase 1: PostgreSQL Architecture)
-- ============================================================================

-- Jobs: Core application state for task execution
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT,
    status TEXT DEFAULT 'todo',
    dataset_id TEXT,
    output TEXT,
    artifacts JSONB,
    exit_code INTEGER,
    container_id TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    selected_skills JSONB,
    skills_invoked JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_dataset_id ON jobs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);

-- Auto-update timestamp trigger for jobs
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_updated_at ON jobs;
CREATE TRIGGER jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Datasets: Uploaded datasets with normalization metadata
CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    format TEXT, -- 'csv', 'json', 'feather'
    record_count INTEGER,
    column_count INTEGER,
    size_bytes INTEGER,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    normalization_status TEXT DEFAULT 'pending', -- 'pending', 'completed', 'failed'
    normalization_confidence REAL,
    normalization_domain TEXT,
    custom_context TEXT, -- User-provided context for agents
    metadata JSONB, -- JSON blob for additional metadata
    parent_dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL, -- lineage: derived from
    source_job_id TEXT,                                                  -- lineage: produced by
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_datasets_uploaded_at ON datasets(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_datasets_normalization_status ON datasets(normalization_status);

DROP TRIGGER IF EXISTS datasets_updated_at ON datasets;
CREATE TRIGGER datasets_updated_at
    BEFORE UPDATE ON datasets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- OBSERVABILITY TABLES
-- ============================================================================

-- Run-level tracking: captures high-level execution metadata
CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    dataset_id TEXT,
    model TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    exit_code INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    error_message TEXT,
    total_cost_usd REAL,
    num_turns INTEGER,
    artifacts_json JSONB,
    selected_skills TEXT,
    skills_invoked TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_job_id ON agent_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_model ON agent_runs(model);

-- Step-level traces: captures turns, thinking blocks, tool calls, tool results
CREATE TABLE IF NOT EXISTS agent_steps (
    step_id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    input TEXT,
    output TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    metadata_json JSONB,
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_steps_run_id ON agent_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_step_number ON agent_steps(step_number);
CREATE INDEX IF NOT EXISTS idx_agent_steps_step_type ON agent_steps(step_type);
CREATE INDEX IF NOT EXISTS idx_agent_steps_started_at ON agent_steps(started_at);

-- Tool call tracking: detailed invocation traces
CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    tool_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json JSONB,
    result_json JSONB,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_number ON tool_calls(turn_number);
CREATE INDEX IF NOT EXISTS idx_tool_calls_started_at ON tool_calls(started_at);

-- Hypothesis tracking
CREATE TABLE IF NOT EXISTS hypotheses (
    hypothesis_id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    hypothesis_text TEXT NOT NULL,
    hypothesis_type TEXT,
    confidence_score REAL,
    extracted_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'pending',
    evaluation_reasoning TEXT,
    expected_importance REAL,
    expected_metric TEXT,
    graph_source TEXT,
    actual_importance REAL,
    feature_name TEXT,
    priority INTEGER DEFAULT 1000,
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_run_id ON hypotheses(run_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);
CREATE INDEX IF NOT EXISTS idx_hypotheses_feature_name ON hypotheses(feature_name);
CREATE INDEX IF NOT EXISTS idx_hypotheses_priority ON hypotheses(priority DESC);

-- Evidence linking
CREATE TABLE IF NOT EXISTS hypothesis_evidence (
    evidence_id SERIAL PRIMARY KEY,
    hypothesis_id INTEGER NOT NULL,
    tool_call_id INTEGER,
    evidence_type TEXT NOT NULL,
    evidence_text TEXT,
    supports BOOLEAN DEFAULT TRUE,
    confidence_score REAL,
    linked_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(hypothesis_id) ON DELETE CASCADE,
    FOREIGN KEY (tool_call_id) REFERENCES tool_calls(tool_call_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hypothesis_evidence_hypothesis_id ON hypothesis_evidence(hypothesis_id);
CREATE INDEX IF NOT EXISTS idx_hypothesis_evidence_tool_call_id ON hypothesis_evidence(tool_call_id);

-- Hypothesis edges: graph relationships between hypotheses
-- Database Registries: named data sources (SQL databases, graph DBs, APIs)
CREATE TABLE IF NOT EXISTS database_registries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'sql',       -- 'sql' | 'graph'
    description TEXT,
    connection_info JSONB,
    skill_id TEXT,                           -- e.g. 'org:csanalyze-dataset-generator'
    icon_color TEXT DEFAULT '#ffd700',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_database_registries_skill_id ON database_registries(skill_id);

DROP TRIGGER IF EXISTS database_registries_updated_at ON database_registries;
CREATE TRIGGER database_registries_updated_at
    BEFORE UPDATE ON database_registries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Dataset normalization tracking
CREATE TABLE IF NOT EXISTS dataset_normalizations (
    normalization_id SERIAL PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    version TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    success BOOLEAN DEFAULT TRUE,
    overall_confidence REAL,
    document_type TEXT,
    num_artifacts INTEGER,
    num_exclusions INTEGER,
    error_message TEXT,
    metadata_json JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dataset_normalizations_dataset_id ON dataset_normalizations(dataset_id);
CREATE INDEX IF NOT EXISTS idx_dataset_normalizations_started_at ON dataset_normalizations(started_at);

-- Feature importance results
CREATE TABLE IF NOT EXISTS feature_importance_results (
    result_id SERIAL PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    hypothesis_id INTEGER,
    feature_name TEXT NOT NULL,
    importance_score REAL NOT NULL,
    model_type TEXT,
    model_auc REAL,
    model_accuracy REAL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(hypothesis_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_importance_dataset ON feature_importance_results(dataset_id);
CREATE INDEX IF NOT EXISTS idx_feature_importance_feature ON feature_importance_results(feature_name);
CREATE INDEX IF NOT EXISTS idx_feature_importance_score ON feature_importance_results(importance_score DESC);

