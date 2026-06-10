'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// JSON columns auto-parsed when reading rows
const JSON_COLS = new Set([
  'artifacts', 'selected_skills', 'skills_invoked', 'metadata',
  'artifacts_json', 'connection_info', 'metadata_json'
]);

function parseRow(row) {
  if (!row) return row;
  for (const key of Object.keys(row)) {
    if (JSON_COLS.has(key) && typeof row[key] === 'string') {
      try { row[key] = JSON.parse(row[key]); } catch (_) {}
    }
  }
  return row;
}

class DatabaseManager {
  constructor() {
    this.db = null;
  }

  async initialize() {
    try {
      const dbDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

      const dbPath = path.join(dbDir, 'executions.db');
      this.db = new Database(dbPath);

      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL');

      console.log('Database connected: SQLite at', dbPath);

      const schemaPath = path.join(__dirname, '..', 'data', 'schema_sqlite.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(schema);
      console.log('Database schema initialized');

      // Migrate alzkb_source → graph_source for existing databases
      try {
        this.db.exec('ALTER TABLE hypotheses RENAME COLUMN alzkb_source TO graph_source');
        console.log('Migrated hypotheses.alzkb_source → graph_source');
      } catch (_) { /* column already renamed or doesn't exist */ }

      // Drop dead tables (idempotent)
      this.db.exec('DROP TABLE IF EXISTS workflow_logs');
      this.db.exec('DROP TABLE IF EXISTS chat_messages');
      this.db.exec('DROP TABLE IF EXISTS conversations');
      this.db.exec('DROP TABLE IF EXISTS orchestrator_config');
      this.db.exec('DROP TABLE IF EXISTS agent_memories');
      this.db.exec('DROP TABLE IF EXISTS templates');

      // Drop dead columns (try/catch — older SQLite lacks IF EXISTS on DROP COLUMN)
      try { this.db.exec('ALTER TABLE jobs DROP COLUMN assignee'); } catch (_) {}
      try { this.db.exec('ALTER TABLE jobs DROP COLUMN recommended_skills'); } catch (_) {}
      try { this.db.exec('ALTER TABLE jobs DROP COLUMN priority'); } catch (_) {}
      try { this.db.exec('ALTER TABLE hypotheses DROP COLUMN confidence_decay_rate'); } catch (_) {}
      try { this.db.exec('ALTER TABLE hypotheses DROP COLUMN requested_evidence_type'); } catch (_) {}
      try { this.db.exec('ALTER TABLE hypotheses DROP COLUMN requested_agent_action'); } catch (_) {}
      try { this.db.exec('ALTER TABLE hypotheses DROP COLUMN parent_hypothesis_id'); } catch (_) {}
      try { this.db.exec('ALTER TABLE agent_runs DROP COLUMN sandbox_id'); } catch (_) {}
      try { this.db.exec('ALTER TABLE agent_runs DROP COLUMN permission_mode'); } catch (_) {}

      // Load sqlite-vec and create vector table for hypothesis embeddings
      try {
        const sqliteVec = require('sqlite-vec');
        sqliteVec.load(this.db);
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_hypotheses USING vec0(
            embedding float[384]
          )
        `);
        this._upsertEmbedding = this.db.transaction((id, buf) => {
          this.db.prepare('DELETE FROM vec_hypotheses WHERE rowid = ?').run(BigInt(id));
          this.db.prepare('INSERT INTO vec_hypotheses(rowid, embedding) VALUES (?, ?)').run(BigInt(id), buf);
        });
        console.log('sqlite-vec loaded: vec_hypotheses ready');
      } catch (e) {
        console.warn('[vec] sqlite-vec unavailable — hypothesis graph disabled:', e.message);
        this._upsertEmbedding = null;
      }

      return true;
    } catch (error) {
      if (this.db) {
        try { this.db.close(); } catch (_) {}
        this.db = null;
      }
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('Database closed');
    }
  }

  // ==================== Run Management ====================

  async createRun(data) {
    const {
      run_id, job_id, prompt,
      dataset_id = null, model = null, selected_skills = null,
      started_at = new Date().toISOString()
    } = data;

    this._run(
      `INSERT INTO agent_runs (run_id, job_id, prompt, dataset_id, model, selected_skills, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      [run_id, job_id, prompt, dataset_id, model, selected_skills, started_at]
    );
    return run_id;
  }

  async updateRun(runId, updates) {
    const allowedFields = [
      'completed_at', 'duration_ms', 'exit_code', 'status', 'error_message',
      'total_cost_usd', 'num_turns', 'artifacts_json', 'skills_invoked', 'model'
    ];

    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    values.push(runId);
    this._run(`UPDATE agent_runs SET ${fields.join(', ')} WHERE run_id = ?`, values);
  }

  async getRun(runId) {
    return this._get('SELECT * FROM agent_runs WHERE run_id = ?', [runId]);
  }

  async listRuns(filters = {}) {
    const { job_id, status, model, limit = 100, offset = 0 } = filters;
    const conditions = [];
    const values = [];

    if (job_id) { conditions.push('job_id = ?'); values.push(job_id); }
    if (status) { conditions.push('status = ?'); values.push(status); }
    if (model) { conditions.push('model = ?'); values.push(model); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);
    return this._all(`SELECT * FROM agent_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`, values);
  }

  // ==================== Step Management ====================

  async createStepsBatch(steps) {
    if (steps.length === 0 || !this.db) return;

    const stmt = this.db.prepare(
      `INSERT INTO agent_steps (run_id, step_number, step_type, input, output,
         started_at, completed_at, duration_ms, success, error_message, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.transaction((items) => {
      for (const step of items) {
        const {
          run_id, step_number, step_type,
          input = null, output = null,
          started_at = new Date().toISOString(),
          completed_at = null, duration_ms = null,
          success = true, error_message = null, metadata_json = null
        } = step;
        stmt.run(run_id, step_number, step_type, input, output,
          started_at, completed_at, duration_ms, success ? 1 : 0, error_message, metadata_json);
      }
    })(steps);
  }

  async getStepsForRun(runId, stepType = null) {
    if (stepType) {
      return this._all(
        'SELECT * FROM agent_steps WHERE run_id = ? AND step_type = ? ORDER BY step_number ASC',
        [runId, stepType]
      );
    }
    return this._all('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_number ASC', [runId]);
  }

  // ==================== Tool Call Management ====================

  async createToolCallsBatch(toolCalls) {
    if (toolCalls.length === 0 || !this.db) return;

    const stmt = this.db.prepare(
      `INSERT INTO tool_calls (run_id, turn_number, tool_id, tool_name, arguments_json, result_json,
         started_at, completed_at, duration_ms, success, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.transaction((items) => {
      for (const tc of items) {
        const {
          run_id, turn_number, tool_id, tool_name,
          arguments_json = null, result_json = null,
          started_at = new Date().toISOString(),
          completed_at = null, duration_ms = null,
          success = true, error_message = null
        } = tc;
        stmt.run(run_id, turn_number, tool_id, tool_name, arguments_json, result_json,
          started_at, completed_at, duration_ms, success ? 1 : 0, error_message);
      }
    })(toolCalls);
  }

  async getToolCallsForRun(runId, toolName = null) {
    if (toolName) {
      return this._all(
        'SELECT * FROM tool_calls WHERE run_id = ? AND tool_name = ? ORDER BY turn_number ASC, started_at ASC',
        [runId, toolName]
      );
    }
    return this._all(
      'SELECT * FROM tool_calls WHERE run_id = ? ORDER BY turn_number ASC, started_at ASC',
      [runId]
    );
  }

  // ==================== Hypothesis Management ====================

  async createHypothesis(data) {
    const {
      run_id, turn_number, hypothesis_text,
      hypothesis_type = null, confidence_score = null,
      extracted_at = new Date().toISOString(),
      status = 'proposed',
      evaluation_reasoning = null,
      expected_importance = null,
      expected_metric = null, graph_source = null,
      actual_importance = null, feature_name = null, priority = 1000
    } = data;

    const result = this._run(
      `INSERT INTO hypotheses (
         run_id, turn_number, hypothesis_text, hypothesis_type, confidence_score,
         extracted_at, status, evaluation_reasoning,
         expected_importance, expected_metric, graph_source, actual_importance, feature_name, priority
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [run_id, turn_number, hypothesis_text, hypothesis_type, confidence_score,
        extracted_at, status, evaluation_reasoning,
        expected_importance, expected_metric, graph_source, actual_importance, feature_name, priority]
    );
    return result.lastID;
  }

  async updateHypothesis(hypothesisId, updates) {
    const allowedFields = [
      'status', 'confidence_score', 'evaluation_reasoning', 'priority',
      'actual_importance', 'feature_name'
    ];

    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    values.push(hypothesisId);
    this._run(`UPDATE hypotheses SET ${fields.join(', ')} WHERE hypothesis_id = ?`, values);
  }

  async getHypothesis(hypothesisId) {
    return this._get('SELECT * FROM hypotheses WHERE hypothesis_id = ?', [hypothesisId]);
  }

  getRunByJobId(jobId) {
    return this._get('SELECT run_id FROM agent_runs WHERE job_id = ? LIMIT 1', [jobId]);
  }

  countHypothesesForRun(runId) {
    const row = this._get('SELECT COUNT(*) as count FROM hypotheses WHERE run_id = ?', [runId]);
    return row ? row.count : 0;
  }

  async listHypotheses(filters = {}) {
    const { run_id, status, hypothesis_type, limit = 100, offset = 0 } = filters;
    const conditions = [];
    const values = [];

    if (run_id) { conditions.push('h.run_id = ?'); values.push(run_id); }
    if (status) { conditions.push('h.status = ?'); values.push(status); }
    if (hypothesis_type) { conditions.push('h.hypothesis_type = ?'); values.push(hypothesis_type); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);
    return this._all(
      `SELECT h.*, ar.job_id, ar.dataset_id AS run_dataset_id
       FROM hypotheses h
       LEFT JOIN agent_runs ar ON h.run_id = ar.run_id
       ${where} ORDER BY h.extracted_at DESC LIMIT ? OFFSET ?`,
      values
    );
  }

  async getHypothesesForDataset(datasetId) {
    return this._all(
      `SELECT h.*
       FROM hypotheses h
       INNER JOIN agent_runs r ON h.run_id = r.run_id
       WHERE r.dataset_id = ?
       ORDER BY h.extracted_at DESC`,
      [datasetId]
    );
  }

  async getHypothesesForRun(runId) {
    return this._all('SELECT * FROM hypotheses WHERE run_id = ? ORDER BY turn_number ASC', [runId]);
  }

  async createEvidence(data) {
    const {
      hypothesis_id, tool_call_id = null, evidence_type,
      evidence_text = null, supports = true, confidence_score = null,
      linked_at = new Date().toISOString()
    } = data;

    const result = this._run(
      `INSERT INTO hypothesis_evidence (hypothesis_id, tool_call_id, evidence_type, evidence_text,
         supports, confidence_score, linked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [hypothesis_id, tool_call_id, evidence_type, evidence_text,
        supports ? 1 : 0, confidence_score, linked_at]
    );
    return result.lastID;
  }

  async getEvidenceForHypothesis(hypothesisId) {
    return this._all(
      `SELECT e.*, t.tool_name, t.arguments_json, t.result_json
       FROM hypothesis_evidence e
       LEFT JOIN tool_calls t ON e.tool_call_id = t.tool_call_id
       WHERE e.hypothesis_id = ?
       ORDER BY e.linked_at ASC`,
      [hypothesisId]
    );
  }

  async linkToolCallToHypothesis(toolCallId, hypothesisId, supports, confidence) {
    const toolCall = this._get('SELECT * FROM tool_calls WHERE tool_call_id = ?', [toolCallId]);
    if (!toolCall) throw new Error(`Tool call ${toolCallId} not found`);

    return this.createEvidence({
      hypothesis_id: hypothesisId,
      tool_call_id: toolCallId,
      evidence_type: 'observation',
      evidence_text: `Tool: ${toolCall.tool_name}`,
      supports,
      confidence_score: confidence
    });
  }

  async getHypothesisWithEvidence(hypothesisId) {
    const hypothesis = await this.getHypothesis(hypothesisId);
    if (!hypothesis) return null;
    const evidence = await this.getEvidenceForHypothesis(hypothesisId);
    return { ...hypothesis, evidence };
  }

  async getUnevaluatedHypotheses() {
    return this._all("SELECT * FROM hypotheses WHERE status = 'evidence_collected' ORDER BY extracted_at ASC");
  }

  async getHypothesesNeedingEvidence() {
    return this._all("SELECT * FROM hypotheses WHERE status = 'test_requested' ORDER BY extracted_at ASC");
  }

  async deleteHypothesis(hypothesisId) {
    this._run('DELETE FROM hypotheses WHERE hypothesis_id = ?', [hypothesisId]);
    if (this._upsertEmbedding) {
      try { this.db.prepare('DELETE FROM vec_hypotheses WHERE rowid = ?').run(BigInt(hypothesisId)); } catch (_) {}
    }
  }

  // ==================== Hypothesis Embeddings ====================

  saveEmbedding(hypothesisId, float32Array) {
    if (!this._upsertEmbedding) return;
    this._upsertEmbedding(hypothesisId, Buffer.from(float32Array.buffer));
  }

  // Returns [{hypothesis_id, distance}] sorted ascending by L2 distance.
  // For unit vectors: cosine_similarity ≈ 1 - distance²/2
  searchSimilar(float32Array, k = 10) {
    if (!this._upsertEmbedding) return [];
    return this.db.prepare(
      'SELECT rowid AS hypothesis_id, distance FROM vec_hypotheses WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
    ).all(Buffer.from(float32Array.buffer), k);
  }

  getEmbeddedIds() {
    if (!this._upsertEmbedding) return new Set();
    return new Set(
      this.db.prepare('SELECT rowid AS hypothesis_id FROM vec_hypotheses').all().map(r => r.hypothesis_id)
    );
  }

  getEmbeddingBuffer(hypothesisId) {
    if (!this._upsertEmbedding) return null;
    const row = this.db.prepare('SELECT embedding FROM vec_hypotheses WHERE rowid = ?').get(BigInt(hypothesisId));
    return row ? row.embedding : null;
  }

  // ==================== Statistics & Analytics ====================

  async getToolUsageStats(runId) {
    return this._all(
      `SELECT
         tool_name,
         COUNT(*) as call_count,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_calls,
         AVG(duration_ms) as avg_duration_ms,
         MIN(duration_ms) as min_duration_ms,
         MAX(duration_ms) as max_duration_ms
       FROM tool_calls WHERE run_id = ?
       GROUP BY tool_name ORDER BY call_count DESC`,
      [runId]
    );
  }

  async getRunWithStats(runId) {
    const run = await this.getRun(runId);
    if (!run) return null;

    const stepCounts = this._all(
      'SELECT step_type, COUNT(*) as count FROM agent_steps WHERE run_id = ? GROUP BY step_type',
      [runId]
    );
    const toolCount = this._get(
      'SELECT COUNT(*) as tool_call_count FROM tool_calls WHERE run_id = ?',
      [runId]
    );

    return {
      ...run,
      step_counts: stepCounts.reduce((acc, { step_type, count }) => {
        acc[step_type] = parseInt(count, 10);
        return acc;
      }, {}),
      tool_call_count: parseInt(toolCount?.tool_call_count, 10) || 0
    };
  }

  // ==================== Database Helpers ====================

  _run(sql, params = []) {
    if (!this.db) throw new Error('Database not available');
    const result = this.db.prepare(sql).run(...params);
    return { lastID: result.lastInsertRowid, changes: result.changes };
  }

  _get(sql, params = []) {
    if (!this.db) return null;
    return parseRow(this.db.prepare(sql).get(...params) || null);
  }

  _all(sql, params = []) {
    if (!this.db) return [];
    return this.db.prepare(sql).all(...params).map(parseRow);
  }

  // ==================== Normalization Tracking ====================

  async trackNormalization(normalizationData) {
    if (!this.db) {
      console.warn('[DatabaseManager] Database not available, skipping normalization tracking');
      return;
    }

    const {
      dataset_id, version, started_at, completed_at, duration_ms, success,
      overall_confidence, document_type, num_artifacts, num_exclusions,
      error_message, metadata_json
    } = normalizationData;

    return this._run(
      `INSERT INTO dataset_normalizations (
         dataset_id, version, started_at, completed_at, duration_ms,
         success, overall_confidence, document_type, num_artifacts,
         num_exclusions, error_message, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dataset_id, version, started_at, completed_at, duration_ms,
        success ? 1 : 0, overall_confidence, document_type, num_artifacts,
        num_exclusions, error_message || null,
        typeof metadata_json === 'object' ? JSON.stringify(metadata_json) : (metadata_json || null)]
    );
  }

  async getNormalizationReport(datasetId) {
    if (!this.db) return null;

    const row = this._get(
      'SELECT * FROM dataset_normalizations WHERE dataset_id = ? ORDER BY started_at DESC LIMIT 1',
      [datasetId]
    );

    if (row && row.metadata_json) {
      if (typeof row.metadata_json === 'string') {
        try { row.metadata = JSON.parse(row.metadata_json); } catch (_) {}
      } else {
        row.metadata = row.metadata_json;
      }
      delete row.metadata_json;
    }

    return row;
  }

  // ==================== Feature Importance ====================

  async insertFeatureImportanceResult(data) {
    if (!this.db) {
      console.warn('[DatabaseManager] Database not available, skipping feature importance result');
      return;
    }

    const result = this._run(
      `INSERT INTO feature_importance_results (
         dataset_id, run_id, hypothesis_id, feature_name, importance_score,
         model_type, model_auc, model_accuracy
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.dataset_id, data.run_id, data.hypothesis_id || null,
        data.feature_name, data.importance_score, data.model_type || null,
        data.model_auc || null, data.model_accuracy || null]
    );
    return result.lastID;
  }

}

const dbManager = new DatabaseManager();
module.exports = dbManager;
