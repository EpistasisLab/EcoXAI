'use strict';

/**
 * Lean Orchestrator — Hardcoded pipeline with event-driven stage execution.
 *
 * To change pipeline behavior: edit PIPELINE_STAGES below.
 * Set auto: false on any stage to require manual /api/pipeline/continue.
 */

const EventEmitter = require('events');

// ═══════════════════════════════════════════════════════
//  PIPELINE CONFIGURATION — Edit this to change behavior
// ═══════════════════════════════════════════════════════
const PIPELINE_STAGES = [
  {
    id: 'normalize',
    name: 'Normalize Dataset',
    trigger: 'dataset_uploaded',
    auto: true,
    // No Docker job — runs normalizationService directly (handled in datasets route)
    noJob: true,
  },
  {
    id: 'explore',
    name: 'Explore & Clean',
    trigger: 'dataset_normalized',
    auto: true,
    skill: 'public:pipeline-explore',
    prompt: 'Run the data exploration and cleaning phase. Follow the pipeline-explore skill instructions in your workspace.',
  },
  {
    id: 'hypothesize',
    name: 'Generate Hypotheses',
    trigger: 'job_completed:explore',
    auto: true,
    skill: ['public:pipeline-hypothesize', 'hypotheses:alzkb-graph-query'],
    prompt: 'Run the hypothesis generation phase. Follow the pipeline-hypothesize skill instructions in your workspace.',
  },
  {
    id: 'analyze',
    name: 'Test & Validate',
    trigger: 'hypotheses_extracted',
    auto: true,
    skill: 'public:pipeline-analyze',
    prompt: `Run the hypothesis testing and validation phase for this specific hypothesis.

**Hypothesis:** {hypothesis_text}

Focus ONLY on this single hypothesis. Follow the pipeline-analyze skill instructions in your workspace.`,
  }
];
// ═══════════════════════════════════════════════════════

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.autoMode = true;
    this.activeStages = new Map(); // datasetId -> { stageId, jobId, startedAt }
    this.hypothesisQueues = new Map(); // datasetId -> hypothesis[]
    this.deps = null;
  }

  /**
   * Initialize with runtime dependencies.
   * Called from server.js after all services are ready.
   */
  init(deps) {
    this.deps = deps;
    // Apply any persisted stage overrides (skill, prompt, name, auto)
    const overrides = deps.state.pipelineStageOverrides || {};
    for (const [stageId, updates] of Object.entries(overrides)) {
      const stage = PIPELINE_STAGES.find(s => s.id === stageId);
      if (stage) Object.assign(stage, updates);
    }
    this._bindEvents();
    console.log('[Orchestrator] Initialized with pipeline stages:', PIPELINE_STAGES.map(s => s.id).join(' → '));
  }

  _bindEvents() {
    // When a dataset is uploaded → trigger normalize (noJob) then explore
    this.on('dataset_uploaded', async ({ datasetId, filename, domain }) => {
      console.log(`[Orchestrator] dataset_uploaded: ${datasetId} (${domain})`);
      this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'completed', null, datasetId);

      // Auto-trigger explore
      await this._maybeAdvance('dataset_normalized', { datasetId });
    });

    // When a job completes → check if it was a pipeline stage
    this.on('job_completed', async ({ jobId, exitCode, datasetId, stageId, artifacts }) => {
      if (!stageId) return;
      const hasArtifacts = Array.isArray(artifacts) && artifacts.length > 0;
      const succeeded = exitCode === 0 || hasArtifacts;
      const status = succeeded ? 'completed' : 'failed';
      this._updateActiveStage(datasetId, status, jobId);
      this._broadcastStageUpdate(stageId, this._getStageName(stageId), status, jobId, datasetId);

      if (!succeeded) {
        console.warn(`[Orchestrator] Stage ${stageId} failed (exit ${exitCode}, no artifacts) for dataset ${datasetId}`);
        return;
      }
      if (exitCode !== 0) {
        console.warn(`[Orchestrator] Stage ${stageId} exited ${exitCode} but produced ${artifacts.length} artifact(s) — treating as completed`);
      }

      // Feed test results back to hypothesis statuses and advance per-hypothesis queue
      if (stageId === 'analyze') {
        const job = (this.deps.state.jobs || []).find(j => j.id === jobId);
        this._processTestResults(datasetId, artifacts, job?._hypothesisId).catch(err =>
          console.warn('[Orchestrator] Verdict processing failed:', err.message)
        );
        await this._runNextHypothesisAnalysis(datasetId);
        return; // analyze doesn't advance to a further stage
      }

      // Trigger next stage based on completed stage
      await this._maybeAdvance(`job_completed:${stageId}`, { datasetId, jobId });
    });

    // When hypotheses are extracted → run one analyze job per hypothesis, sequentially
    this.on('hypotheses_extracted', async ({ jobId, datasetId, count }) => {
      console.log(`[Orchestrator] hypotheses_extracted: ${count} for dataset ${datasetId}`);
      const { dbManager } = this.deps;
      if (!dbManager) return;
      const hypotheses = await dbManager.getHypothesesForDataset(datasetId);
      if (!hypotheses.length) return;
      this.hypothesisQueues.set(datasetId, [...hypotheses]);
      await this._runNextHypothesisAnalysis(datasetId);
    });
  }

  async _runNextHypothesisAnalysis(datasetId) {
    const queue = this.hypothesisQueues.get(datasetId);
    if (!queue || !queue.length) {
      this.hypothesisQueues.delete(datasetId);
      console.log(`[Orchestrator] All hypotheses tested for dataset ${datasetId}`);
      return;
    }
    const hypothesis = queue.shift();
    const stage = PIPELINE_STAGES.find(s => s.id === 'analyze');
    console.log(`[Orchestrator] Testing hypothesis ${hypothesis.hypothesis_id} (${queue.length} remaining) for dataset ${datasetId}`);
    await this._runStage(stage, { datasetId, hypothesis });
  }

  async _maybeAdvance(trigger, context) {
    const stage = PIPELINE_STAGES.find(s => s.trigger === trigger);
    if (!stage) return;
    if (stage.noJob) return; // normalize handled separately

    if (!this.autoMode) {
      console.log(`[Orchestrator] Auto-mode off, skipping stage ${stage.id} (trigger: ${trigger})`);
      this._broadcastStageUpdate(stage.id, stage.name, 'waiting', null, context.datasetId);
      return;
    }

    await this._runStage(stage, context);
  }

  async _runStage(stage, context) {
    const { datasetId } = context;
    if (!datasetId) return;

    console.log(`[Orchestrator] Running stage: ${stage.id} for dataset ${datasetId}`);
    this._broadcastStageUpdate(stage.id, stage.name, 'running', null, datasetId);

    try {
      const { state, saveState, broadcast, findJob, updateJob, startJobExecution } = this.deps;

      // Build prompt with dataset and hypothesis substitution
      const { hypothesis } = context;
      let prompt = stage.prompt.replace(/\{datasetId\}/g, datasetId);
      if (hypothesis) {
        prompt = prompt.replace(/\{hypothesis_text\}/g, hypothesis.hypothesis_text || '');
      }

      const jobTitle = hypothesis?.feature_name
        ? `[Pipeline] ${stage.name}: ${hypothesis.feature_name}`
        : `[Pipeline] ${stage.name}`;

      // Create job
      const job = {
        id: `J${Date.now()}_${stage.id}`,
        title: jobTitle,
        status: 'todo',
        prompt,
        datasetId,
        selectedSkills: stage.skill ? (Array.isArray(stage.skill) ? stage.skill : [stage.skill]) : [],
        skillsInvoked: [],
        output: '',
        artifacts: [],
        exitCode: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        _stageId: stage.id,   // Tag so jobExecution can emit the right event
        _pipelineDatasetId: datasetId,
        _hypothesisId: hypothesis?.hypothesis_id ?? null,
      };

      state.jobs.push(job);
      saveState();
      broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });

      this._recordActiveStage(stage.id, datasetId, job.id);

      // Execute
      const result = await startJobExecution(job.id, {});
      if (!result.success) {
        console.error(`[Orchestrator] Failed to start stage ${stage.id}:`, result.error);
        this._broadcastStageUpdate(stage.id, stage.name, 'failed', job.id, datasetId);
      }
    } catch (error) {
      console.error(`[Orchestrator] Stage ${stage.id} error:`, error.message);
      this._broadcastStageUpdate(stage.id, stage.name, 'failed', null, datasetId);
    }
  }

  // ── Manual controls ──────────────────────────────────

  pause() {
    this.autoMode = false;
    console.log('[Orchestrator] Auto-mode disabled');
    if (this.deps) this.deps.broadcast({ type: 'PIPELINE_STAGE_UPDATE', autoMode: false });
  }

  resume() {
    this.autoMode = true;
    console.log('[Orchestrator] Auto-mode enabled');
    if (this.deps) this.deps.broadcast({ type: 'PIPELINE_STAGE_UPDATE', autoMode: true });
    setImmediate(() => this._advanceStuckDatasets().catch(err => console.error('[Orchestrator] Resume advance error:', err.message)));
  }

  async _advanceStuckDatasets() {
    if (!this.deps) return;
    const jobs = this.deps.state.jobs || [];

    // Find last completed pipeline stage per dataset
    const lastCompleted = {};
    for (const job of jobs) {
      if (!job._stageId || !job.datasetId || job.status !== 'completed') continue;
      const prev = lastCompleted[job.datasetId];
      if (!prev || job.completedAt > prev.completedAt) lastCompleted[job.datasetId] = job;
    }

    for (const [datasetId, job] of Object.entries(lastCompleted)) {
      const stageIdx = PIPELINE_STAGES.findIndex(s => s.id === job._stageId);
      if (stageIdx < 0 || stageIdx >= PIPELINE_STAGES.length - 1) continue;
      const nextStage = PIPELINE_STAGES[stageIdx + 1];
      if (nextStage.noJob) continue;

      const alreadyStarted = jobs.some(j => j._stageId === nextStage.id && j.datasetId === datasetId);
      if (!alreadyStarted) {
        console.log(`[Orchestrator] Resume: advancing ${datasetId} from ${job._stageId} → ${nextStage.id}`);
        await this._runStage(nextStage, { datasetId });
      }
    }
  }

  async triggerStage(stageId, { datasetId }) {
    const stage = PIPELINE_STAGES.find(s => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage: ${stageId}`);
    if (!datasetId) throw new Error('datasetId required');
    await this._runStage(stage, { datasetId });
  }

  getStatus() {
    return {
      autoMode: this.autoMode,
      stages: PIPELINE_STAGES.map(s => ({
        id: s.id,
        name: s.name,
        trigger: s.trigger,
        auto: s.auto,
        noJob: s.noJob || false,
        skill: s.skill ? (Array.isArray(s.skill) ? s.skill : [s.skill]) : [],
        prompt: s.prompt || '',
      })),
      active: Array.from(this.activeStages.entries()).map(([datasetId, info]) => ({ datasetId, ...info }))
    };
  }

  updateStage(stageId, { skill, prompt, name, auto }) {
    const stage = PIPELINE_STAGES.find(s => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage: ${stageId}`);

    const changes = {};
    if (skill !== undefined) changes.skill = Array.isArray(skill) ? skill : [skill];
    if (prompt !== undefined) changes.prompt = prompt;
    if (name !== undefined) changes.name = name;
    if (auto !== undefined) changes.auto = !!auto;

    Object.assign(stage, changes);

    if (this.deps?.state) {
      if (!this.deps.state.pipelineStageOverrides) this.deps.state.pipelineStageOverrides = {};
      this.deps.state.pipelineStageOverrides[stageId] = {
        ...(this.deps.state.pipelineStageOverrides[stageId] || {}),
        ...changes,
      };
      this.deps.saveState();
    }

    const updated = this.getStatus().stages.find(s => s.id === stageId);
    if (this.deps?.broadcast) {
      this.deps.broadcast({ type: 'PIPELINE_STAGE_CONFIG_UPDATE', stage: updated });
    }
    return updated;
  }

  async _processTestResults(datasetId, artifacts, hypothesisId = null) {
    const { dbManager, broadcast } = this.deps;
    if (!dbManager) return;

    const importanceArtifact = (artifacts || []).find(a => {
      const name = typeof a === 'string' ? a : (a.name || a.path || '');
      return name === 'feature_importance_results.json' || name.endsWith('/feature_importance_results.json');
    });
    if (!importanceArtifact?.content) return;

    try {
      const importanceData = JSON.parse(importanceArtifact.content);
      const importanceByFeature = {};
      for (const item of importanceData) {
        if (item.feature && item.importance != null) importanceByFeature[item.feature] = item.importance;
      }

      const allHypotheses = await dbManager.getHypothesesForDataset(datasetId);
      const hypotheses = hypothesisId
        ? allHypotheses.filter(h => h.hypothesis_id === hypothesisId)
        : allHypotheses;
      let updated = 0;
      for (const hyp of hypotheses) {
        if (!hyp.feature_name) continue;
        const actual = importanceByFeature[hyp.feature_name];
        if (actual == null) continue;
        const expected = hyp.expected_importance ?? 0;
        const newStatus = actual >= expected ? 'supported'
          : (expected > 0 && actual >= expected * 0.5) ? 'needs_more_data'
          : 'rejected';
        await dbManager.updateHypothesis(hyp.hypothesis_id, { status: newStatus, actual_importance: actual });
        updated++;
      }

      if (updated > 0) {
        broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses' });
        console.log(`[Orchestrator] Updated ${updated} hypothesis verdicts for dataset ${datasetId}`);
      }
    } catch (err) {
      console.warn('[Orchestrator] _processTestResults error:', err.message);
    }
  }

  // ── Internal helpers ──────────────────────────────────

  _getStageName(stageId) {
    return PIPELINE_STAGES.find(s => s.id === stageId)?.name || stageId;
  }

  _recordActiveStage(stageId, datasetId, jobId) {
    this.activeStages.set(datasetId, { stageId, jobId, startedAt: new Date().toISOString() });
  }

  _updateActiveStage(datasetId, status, jobId) {
    const active = this.activeStages.get(datasetId);
    if (active) {
      if (status !== 'running') this.activeStages.delete(datasetId);
    }
  }

  _broadcastStageUpdate(stageId, stageName, status, jobId, datasetId) {
    if (this.deps?.broadcast) {
      this.deps.broadcast({
        type: 'PIPELINE_STAGE_UPDATE',
        stageId,
        stageName,
        status,
        jobId: jobId || null,
        datasetId: datasetId || null,
        autoMode: this.autoMode
      });
    }
  }
}

module.exports = new Orchestrator();
