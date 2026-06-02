-- SQLite Schema for EcoXAI Lean Backend
-- Auto-created by databaseManager.js on first initialization

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT,
    priority TEXT DEFAULT 'Medium',
    status TEXT DEFAULT 'todo',
    assignee TEXT,
    dataset_id TEXT,
    output TEXT,
    artifacts TEXT,
    exit_code INTEGER,
    container_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    selected_skills TEXT,
    recommended_skills TEXT,
    skills_invoked TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_dataset_id ON jobs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_assignee ON jobs(assignee);

CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    format TEXT,
    record_count INTEGER,
    column_count INTEGER,
    size_bytes INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now')),
    normalization_status TEXT DEFAULT 'pending',
    normalization_confidence REAL,
    normalization_domain TEXT,
    custom_context TEXT,
    metadata TEXT,
    parent_dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
    source_job_id TEXT,
    source_database_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_datasets_uploaded_at ON datasets(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_datasets_normalization_status ON datasets(normalization_status);
CREATE INDEX IF NOT EXISTS idx_datasets_source_database ON datasets(source_database_id);

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    dataset_id TEXT,
    model TEXT,
    sandbox_id TEXT,
    permission_mode TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    exit_code INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    error_message TEXT,
    total_cost_usd REAL,
    num_turns INTEGER,
    artifacts_json TEXT,
    selected_skills TEXT,
    skills_invoked TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_job_id ON agent_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_model ON agent_runs(model);

CREATE TABLE IF NOT EXISTS agent_steps (
    step_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    input TEXT,
    output TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    metadata_json TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_steps_run_id ON agent_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_step_number ON agent_steps(step_number);
CREATE INDEX IF NOT EXISTS idx_agent_steps_step_type ON agent_steps(step_type);
CREATE INDEX IF NOT EXISTS idx_agent_steps_started_at ON agent_steps(started_at);

CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    tool_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT,
    result_json TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_number ON tool_calls(turn_number);
CREATE INDEX IF NOT EXISTS idx_tool_calls_started_at ON tool_calls(started_at);

CREATE TABLE IF NOT EXISTS hypotheses (
    hypothesis_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    hypothesis_text TEXT NOT NULL,
    hypothesis_type TEXT,
    confidence_score REAL,
    extracted_at TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS hypothesis_evidence (
    evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis_id INTEGER NOT NULL,
    tool_call_id INTEGER,
    evidence_type TEXT NOT NULL,
    evidence_text TEXT,
    supports INTEGER DEFAULT 1,
    confidence_score REAL,
    linked_at TEXT NOT NULL,
    FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(hypothesis_id) ON DELETE CASCADE,
    FOREIGN KEY (tool_call_id) REFERENCES tool_calls(tool_call_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hypothesis_evidence_hypothesis_id ON hypothesis_evidence(hypothesis_id);
CREATE INDEX IF NOT EXISTS idx_hypothesis_evidence_tool_call_id ON hypothesis_evidence(tool_call_id);


CREATE TABLE IF NOT EXISTS database_registries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'sql',
    description TEXT,
    connection_info TEXT,
    skill_id TEXT,
    icon_color TEXT DEFAULT '#ffd700',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_database_registries_skill_id ON database_registries(skill_id);

CREATE TABLE IF NOT EXISTS dataset_normalizations (
    normalization_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id TEXT NOT NULL,
    version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    success INTEGER DEFAULT 1,
    overall_confidence REAL,
    document_type TEXT,
    num_artifacts INTEGER,
    num_exclusions INTEGER,
    error_message TEXT,
    metadata_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dataset_normalizations_dataset_id ON dataset_normalizations(dataset_id);
CREATE INDEX IF NOT EXISTS idx_dataset_normalizations_started_at ON dataset_normalizations(started_at);

CREATE TABLE IF NOT EXISTS feature_importance_results (
    result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    hypothesis_id INTEGER,
    feature_name TEXT NOT NULL,
    importance_score REAL NOT NULL,
    model_type TEXT,
    model_auc REAL,
    model_accuracy REAL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(hypothesis_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_importance_dataset ON feature_importance_results(dataset_id);
CREATE INDEX IF NOT EXISTS idx_feature_importance_feature ON feature_importance_results(feature_name);
CREATE INDEX IF NOT EXISTS idx_feature_importance_score ON feature_importance_results(importance_score DESC);

CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    version TEXT DEFAULT '1.0.0',
    skills TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    agent_type TEXT,
    memory_max_chars INTEGER DEFAULT 2200,
    memory TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name);
CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at);

CREATE TABLE IF NOT EXISTS agent_memories (
    agent_name TEXT PRIMARY KEY,
    memory_content TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    title TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_is_pinned ON conversations(is_pinned);
CREATE INDEX IF NOT EXISTS idx_conversations_is_archived ON conversations(is_archived);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#111827',
    text TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'chat',
    is_user INTEGER NOT NULL DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_message_type ON chat_messages(message_type);

CREATE TABLE IF NOT EXISTS orchestrator_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT,
    trigger_event TEXT NOT NULL,
    trigger_payload TEXT,
    actions_executed TEXT,
    status TEXT DEFAULT 'running',
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_logs_workflow ON workflow_logs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_status ON workflow_logs(status);
