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
    priority TEXT DEFAULT 'Medium',
    status TEXT DEFAULT 'todo',
    assignee TEXT,
    dataset_id TEXT,
    output TEXT,
    artifacts JSONB, -- JSON array of artifact filenames
    exit_code INTEGER,
    container_id TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    selected_skills JSONB, -- JSON array of skill names
    recommended_skills JSONB, -- JSON array of skill names
    skills_invoked JSONB, -- JSON array of skill names
    metadata JSONB, -- Workflow metadata (_databaseId, _poolId, executionTarget, autoMode)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_dataset_id ON jobs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_assignee ON jobs(assignee);

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
    sandbox_id TEXT,
    permission_mode TEXT,
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
    requested_evidence_type TEXT,
    requested_agent_action TEXT,
    evaluation_reasoning TEXT,
    parent_hypothesis_id INTEGER REFERENCES hypotheses(hypothesis_id),
    confidence_decay_rate REAL DEFAULT 0.0,
    expected_importance REAL,
    expected_metric TEXT,
    alzkb_source TEXT,
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
CREATE TABLE IF NOT EXISTS hypothesis_edges (
    edge_id SERIAL PRIMARY KEY,
    from_hypothesis_id INTEGER NOT NULL,
    to_hypothesis_id INTEGER NOT NULL,
    edge_type TEXT NOT NULL,
    reasoning TEXT,
    confidence REAL DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (from_hypothesis_id) REFERENCES hypotheses(hypothesis_id) ON DELETE CASCADE,
    FOREIGN KEY (to_hypothesis_id) REFERENCES hypotheses(hypothesis_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hypothesis_edges_from ON hypothesis_edges(from_hypothesis_id);
CREATE INDEX IF NOT EXISTS idx_hypothesis_edges_to ON hypothesis_edges(to_hypothesis_id);
CREATE INDEX IF NOT EXISTS idx_hypothesis_edges_type ON hypothesis_edges(edge_type);

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

-- ============================================================================
-- TEMPLATES AND AGENT MEMORIES
-- ============================================================================

-- Templates: task context definitions with skills and memory
CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    version TEXT DEFAULT '1.0.0',
    skills JSONB DEFAULT '[]'::jsonb,
    tags JSONB DEFAULT '[]'::jsonb,
    agent_type JSONB,
    memory_max_chars INTEGER DEFAULT 2200,
    memory TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name);
CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at);

DROP TRIGGER IF EXISTS templates_updated_at ON templates;
CREATE TRIGGER templates_updated_at
    BEFORE UPDATE ON templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Agent memories: persistent hot memory per named agent
CREATE TABLE IF NOT EXISTS agent_memories (
    agent_name TEXT PRIMARY KEY,
    memory_content TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS agent_memories_updated_at ON agent_memories;
CREATE TRIGGER agent_memories_updated_at
    BEFORE UPDATE ON agent_memories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- CHAT PERSISTENCE
-- ============================================================================

-- Conversations: named chat sessions per user
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    title TEXT,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_is_pinned ON conversations(is_pinned);
CREATE INDEX IF NOT EXISTS idx_conversations_is_archived ON conversations(is_archived);

DROP TRIGGER IF EXISTS conversations_updated_at ON conversations;
CREATE TRIGGER conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Messages: individual chat turns within a conversation
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#111827',
    text TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'chat',
    is_user BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_message_type ON chat_messages(message_type);

-- ============================================================================
-- ORCHESTRATOR / WORKFLOW ENGINE
-- ============================================================================

-- Key-value config store for orchestrator (pools, workflows, slurm defaults)
CREATE TABLE IF NOT EXISTS orchestrator_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Workflow execution log entries
CREATE TABLE IF NOT EXISTS workflow_logs (
    id SERIAL PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT,
    trigger_event TEXT NOT NULL,
    trigger_payload JSONB,
    actions_executed JSONB,
    status TEXT DEFAULT 'running',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_logs_workflow ON workflow_logs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_status ON workflow_logs(status);
