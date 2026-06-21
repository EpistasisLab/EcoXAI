'use strict';

/**
 * Lean Orchestrator — Hardcoded pipeline with event-driven stage execution.
 *
 * To change pipeline behavior: edit PIPELINE_STAGES below.
 * Set auto: false on any stage to require manual /api/pipeline/continue.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { evaluateHypothesisFromReport } = require('./services/jobPostCompletion');

function extractConclusionFromReport(reportContent) {
  const targetHeadings = ['conclusion', 'summary', 'findings', 'results'];
  const lines = reportContent.split('\n');
  let inSection = false;
  const collected = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      const title = headingMatch[1].toLowerCase().trim();
      inSection = targetHeadings.some(h => title.includes(h));
      continue;
    }
    if (inSection) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('|') && !trimmed.startsWith('```')) {
        collected.push(trimmed);
        if (collected.join(' ').length > 400) break;
      }
    }
  }

  const text = collected.join(' ').trim();
  if (!text) return null;
  return text.length > 500 ? text.substring(0, 497) + '...' : text;
}

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

const MAX_STAGE_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.autoMode = true;
    this.activeStages = new Map(); // datasetId -> { stageId, jobId, startedAt }
    this.hypothesisQueues = new Map(); // datasetId -> hypothesis[]
    this.hypothesisCycles = new Map(); // datasetId -> regeneration count so far
    this.stageRetryAttempts = new Map(); // `${datasetId}:${stageId}[:${hypothesisId}]` -> attempt count
    this.deps = null;
  }

  /**
   * Initialize with runtime dependencies.
   * Called from server.js after all services are ready.
   */
  init(deps) {
    this.deps = deps;
    this.autoMode = deps.state.pipelineAutoMode !== undefined ? deps.state.pipelineAutoMode : false;
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
      const succeeded = exitCode === 0;

      if (!succeeded) {
        this._updateActiveStage(datasetId, 'failed', jobId);
        console.warn(`[Orchestrator] Stage ${stageId} failed (exit ${exitCode}) for dataset ${datasetId}`);

        const job = (this.deps.state.jobs || []).find(j => j.id === jobId);
        const hypothesisId = job?._hypothesisId ?? null;
        const retryKey = hypothesisId ? `${datasetId}:${stageId}:${hypothesisId}` : `${datasetId}:${stageId}`;
        const attempts = (this.stageRetryAttempts.get(retryKey) || 0) + 1;

        if (attempts <= MAX_STAGE_RETRIES) {
          this.stageRetryAttempts.set(retryKey, attempts);
          console.log(`[Orchestrator] Scheduling retry ${attempts}/${MAX_STAGE_RETRIES} for stage ${stageId} in ${RETRY_DELAY_MS}ms`);
          this._broadcastStageUpdate(stageId, this._getStageName(stageId), 'retrying', jobId, datasetId);
          setTimeout(() => {
            this._retryStage(stageId, datasetId, hypothesisId).catch(err =>
              console.error(`[Orchestrator] Retry failed for ${stageId}:`, err.message)
            );
          }, RETRY_DELAY_MS);
        } else {
          this.stageRetryAttempts.delete(retryKey);
          console.warn(`[Orchestrator] Stage ${stageId} permanently failed after ${MAX_STAGE_RETRIES} retries for dataset ${datasetId}`);
          this._broadcastStageUpdate(stageId, this._getStageName(stageId), 'failed', jobId, datasetId);
        }
        return;
      }

      this._updateActiveStage(datasetId, 'completed', jobId);

      // Clear retry counter on success
      const job = (this.deps.state.jobs || []).find(j => j.id === jobId);
      const hypothesisId = job?._hypothesisId ?? null;
      const retryKey = hypothesisId ? `${datasetId}:${stageId}:${hypothesisId}` : `${datasetId}:${stageId}`;
      this.stageRetryAttempts.delete(retryKey);

      this._broadcastStageUpdate(stageId, this._getStageName(stageId), 'completed', jobId, datasetId);

      // Feed test results back to hypothesis statuses and advance per-hypothesis queue
      if (stageId === 'analyze') {
        this.deps.broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses' });
        this._processTestResults(datasetId, artifacts, job?._hypothesisId).catch(err =>
          console.warn('[Orchestrator] Verdict processing failed:', err.message)
        );
        await this._runNextHypothesisAnalysis(datasetId);
        await this._deleteWorkspaceVolume(jobId);
        return; // analyze doesn't advance to a further stage
      }

      // After explore: promote cleaned_data.csv to shared datasets volume for downstream stages
      if (stageId === 'explore') {
        const { volumeManager } = this.deps;
        if (volumeManager) {
          await volumeManager.copyCleanedDatasetToVolume(datasetId, jobId).catch(err =>
            console.warn('[Orchestrator] Failed to copy cleaned dataset to volume:', err.message)
          );
        }
      }

      // Trigger next stage based on completed stage
      await this._maybeAdvance(`job_completed:${stageId}`, { datasetId, jobId });

      // Delete workspace volume after all stage-specific processing is complete
      await this._deleteWorkspaceVolume(jobId);
    });

    // When hypotheses are extracted → run one analyze job per hypothesis, sequentially
    this.on('hypotheses_extracted', async ({ jobId, datasetId, count }) => {
      console.log(`[Orchestrator] hypotheses_extracted: ${count} for dataset ${datasetId}`);
      const { dbManager } = this.deps;
      if (!dbManager) return;
      const hypotheses = (await dbManager.getHypothesesForDataset(datasetId))
        .filter(h => h.status === 'proposed');
      if (!hypotheses.length) return;
      this.hypothesisQueues.set(datasetId, [...hypotheses]);
      await this._runNextHypothesisAnalysis(datasetId);
    });
  }

  async _runNextHypothesisAnalysis(datasetId) {
    if (!this.autoMode) {
      console.log(`[Orchestrator] Auto-mode off, skipping hypothesis analysis for ${datasetId}`);
      return;
    }

    const queue = this.hypothesisQueues.get(datasetId);

    const runningAnalyzeCount = (this.deps.state.jobs || [])
      .filter(j => j.status === 'in-progress' && j._stageId === 'analyze' && j.datasetId === datasetId)
      .length;

    // All done only when queue is empty AND no running analyze jobs remain
    if ((!queue || !queue.length) && runningAnalyzeCount === 0) {
      this.hypothesisQueues.delete(datasetId);
      const done = (this.hypothesisCycles.get(datasetId) || 0) + 1;
      const max = this.deps.state.settings?.maxHypothesisCycles ?? 2;
      if (done <= max) {
        console.log(`[Orchestrator] All hypotheses tested. Regeneration cycle ${done}/${max} for dataset ${datasetId}`);
        this.hypothesisCycles.set(datasetId, done);
        await this._runHypothesizeWithContext(datasetId);
      } else {
        console.log(`[Orchestrator] All hypotheses tested. Reached max regeneration cycles (${max}) for dataset ${datasetId}`);
        this.hypothesisCycles.delete(datasetId);
      }
      return;
    }

    if (!queue || !queue.length) return; // Queue empty, still waiting for in-flight jobs

    const maxParallelJobs = this.deps.state.settings?.maxParallelJobs ?? 3;
    const availableSlots = Math.max(0, maxParallelJobs - runningAnalyzeCount);
    if (availableSlots === 0) return;

    const stage = PIPELINE_STAGES.find(s => s.id === 'analyze');
    const toRun = queue.splice(0, availableSlots); // safely handles fewer items than slots
    for (const hypothesis of toRun) {
      console.log(`[Orchestrator] Testing hypothesis ${hypothesis.hypothesis_id} (${queue.length} remaining) for dataset ${datasetId}`);
      await this._runStage(stage, { datasetId, hypothesis });
    }
  }

  async _runHypothesizeWithContext(datasetId) {
    const stage = PIPELINE_STAGES.find(s => s.id === 'hypothesize');
    const { dbManager } = this.deps;
    const context = { datasetId };
    if (dbManager) {
      const all = await dbManager.getHypothesesForDataset(datasetId);
      const tested = all.filter(h => ['supported', 'rejected', 'needs_more_data'].includes(h.status));
      if (tested.length) {
        context.previousHypotheses = tested.map(h => `- ${h.hypothesis_text} (${h.status})`).join('\n');
      }
    }
    await this._runStage(stage, context);
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
      if (context.previousHypotheses) {
        prompt += `\n\nPreviously tested hypotheses — do NOT regenerate these:\n${context.previousHypotheses}`;
      }
      const dataset = state.datasets[datasetId];
      if (dataset?.userContext) {
        prompt += `\n\nUser-provided context about this dataset:\n${dataset.userContext}`;
      }

      const jobTitle = hypothesis?.feature_name
        ? `[Pipeline] ${stage.name}: ${hypothesis.feature_name}`
        : `[Pipeline] ${stage.name}`;

      // Create job
      // Attach explore report for stages that benefit from prior exploration context
      let explorationReport = null;
      if (stage.id === 'hypothesize' || stage.id === 'analyze') {
        const exploreJob = (state.jobs || [])
          .filter(j => j._stageId === 'explore' && j.datasetId === datasetId && j.status === 'completed')
          .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
          .at(0);
        if (exploreJob) {
          const reportArtifact = (exploreJob.artifacts || []).find(a => {
            const n = a.name || '';
            return n === 'report.md' || n === 'exploration_report.md';
          });
          explorationReport = reportArtifact?.content ?? null;
        }
      }

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
        _explorationReport: explorationReport,
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
    if (this.deps) {
      this.deps.state.pipelineAutoMode = false;
      this.deps.saveState();
      this.deps.broadcast({ type: 'PIPELINE_STAGE_UPDATE', autoMode: false });
    }
  }

  resume() {
    this.autoMode = true;
    console.log('[Orchestrator] Auto-mode enabled');
    if (this.deps) {
      this.deps.state.pipelineAutoMode = true;
      this.deps.saveState();
      this.deps.broadcast({ type: 'PIPELINE_STAGE_UPDATE', autoMode: true });
    }
    setImmediate(() => this._advanceStuckDatasets().catch(err => console.error('[Orchestrator] Resume advance error:', err.message)));
  }

  async _normalizeAndStart(datasetId) {
    const { state, saveState, broadcast, volumeManager, normalizationService, dbManager } = this.deps;
    const dataset = state.datasets[datasetId];
    if (!dataset || dataset.status !== 'pending') return;

    const pendingFilePath = dataset._pendingFilePath;
    if (!pendingFilePath || !fs.existsSync(pendingFilePath)) {
      console.error(`[Orchestrator] Pending file missing for ${datasetId}`);
      return;
    }

    this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'running', null, datasetId);
    const startedAt = new Date().toISOString();

    try {
      const buffer = fs.readFileSync(pendingFilePath);
      const normResult = await normalizationService.normalizeDataset(datasetId, dataset.filename, buffer, ({ stage, total, name, detail }) => {
        this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'running', null, datasetId, `[${stage}/${total}] ${name}${detail ? ': ' + detail : ''}`);
      });
      if (!normResult.success) {
        const isHardStop = normResult.error?.startsWith('[HARD STOP]');
        console.error(`[Orchestrator] Normalization failed for ${datasetId}:`, normResult.error);
        this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'failed', null, datasetId,
          isHardStop ? normResult.error : undefined);
        if (isHardStop) {
          state.datasets[datasetId].status = 'rejected';
          state.datasets[datasetId].rejectionReason = normResult.error;
          saveState();
          broadcast({ type: 'DATASETS_PROMOTED', datasets: Object.values(state.datasets) });
        }
        return;
      }

      const copyResult = await volumeManager.copyNormalizedDatasetToVolume(datasetId, normResult.normalizedPath);
      if (!copyResult.success) {
        console.error(`[Orchestrator] Volume copy failed for ${datasetId}:`, copyResult.error);
        this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'failed', null, datasetId);
        return;
      }

      state.datasets[datasetId] = {
        ...dataset,
        status: 'active',
        normalization: {
          version: normResult.version,
          confidence: normResult.overallConfidence,
          documentType: normResult.documentType,
          artifacts: normResult.artifacts,
          excluded: normResult.excluded,
          semanticMetadata: normResult.semanticMetadata,
          normalizedPath: normResult.normalizedPath,
        },
      };
      delete state.datasets[datasetId]._pendingFilePath;
      saveState();
      broadcast({ type: 'DATASETS_PROMOTED', datasets: Object.values(state.datasets) });
      this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'completed', null, datasetId);

      // Clean up pending file
      try { fs.unlinkSync(pendingFilePath); } catch (_) {}
      try { fs.rmdirSync(path.dirname(pendingFilePath)); } catch (_) {}

      if (dbManager) {
        try {
          await dbManager.trackNormalization({
            dataset_id: datasetId,
            version: normResult.version,
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            duration_ms: normResult.durationMs,
            success: 1,
            overall_confidence: normResult.overallConfidence,
            document_type: normResult.documentType,
            num_artifacts: normResult.artifacts.length,
            num_exclusions: normResult.excluded.length,
            metadata_json: JSON.stringify(normResult.semanticMetadata),
          });
        } catch (dbErr) {
          console.warn('[Orchestrator] DB normalization tracking failed:', dbErr.message);
        }
      }

      // Async wiki portrait (non-blocking)
      const wikiService = require('./services/wikiService');
      volumeManager.readDatasetContext(datasetId)
        .then(ctx => wikiService.compilePortrait(datasetId, state.datasets[datasetId], ctx))
        .then(() => broadcast({ type: 'WIKI_UPDATE', datasetId }))
        .catch(err => console.warn(`[Wiki] Portrait failed:`, err.message));

      const exploreStage = PIPELINE_STAGES.find(s => s.id === 'explore');
      if (exploreStage) await this._runStage(exploreStage, { datasetId });

    } catch (err) {
      console.error(`[Orchestrator] _normalizeAndStart failed for ${datasetId}:`, err.message);
      this._broadcastStageUpdate('normalize', 'Normalize Dataset', 'failed', null, datasetId);
    }
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

    // Normalize and start datasets that were uploaded while the pipeline was paused
    for (const [datasetId, dataset] of Object.entries(this.deps.state.datasets || {})) {
      if (dataset.status !== 'pending') continue;
      console.log(`[Orchestrator] Resume: normalizing dataset ${datasetId} (uploaded while paused)`);
      await this._normalizeAndStart(datasetId);
    }

    // Resume any paused hypothesis analysis queues (in-memory queue survived the pause)
    for (const [datasetId, queue] of this.hypothesisQueues.entries()) {
      if (!queue || !queue.length) continue;
      const hasRunning = jobs.some(j => j._stageId === 'analyze' && j.datasetId === datasetId && j.status === 'running');
      if (!hasRunning) {
        console.log(`[Orchestrator] Resume: resuming in-memory hypothesis queue for ${datasetId} (${queue.length} remaining)`);
        await this._runNextHypothesisAnalysis(datasetId);
      }
    }

    // Rebuild hypothesis queue from DB for datasets where the queue was lost (e.g. server restart)
    if (this.deps.dbManager) {
      const datasetsWithHypothesizeComplete = [...new Set(
        jobs.filter(j => j._stageId === 'hypothesize' && j.status === 'completed').map(j => j.datasetId)
      )];
      for (const datasetId of datasetsWithHypothesizeComplete) {
        if (this.hypothesisQueues.has(datasetId)) continue; // already handled above
        const hasRunning = jobs.some(j => j._stageId === 'analyze' && j.datasetId === datasetId && j.status === 'running');
        if (hasRunning) continue;
        const allHypotheses = await this.deps.dbManager.getHypothesesForDataset(datasetId);
        const untested = allHypotheses.filter(h => h.status === 'proposed');
        if (untested.length > 0) {
          console.log(`[Orchestrator] Resume: rebuilding hypothesis queue for ${datasetId} from DB (${untested.length} untested)`);
          this.hypothesisQueues.set(datasetId, [...untested]);
          await this._runNextHypothesisAnalysis(datasetId);
        }
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

  async _deleteWorkspaceVolume(jobId) {
    const { volumeManager } = this.deps;
    if (volumeManager) {
      await volumeManager.deleteWorkspaceVolume(jobId).catch(err =>
        console.warn(`[Orchestrator] Failed to delete workspace volume for ${jobId}:`, err.message)
      );
    }
  }

  async reprocessVerdictsFromDB(datasetId) {
    const { dbManager } = this.deps;
    if (!dbManager) return { processed: 0 };
    const rows = dbManager._all(
      `SELECT * FROM agent_runs WHERE dataset_id = ? AND artifacts_json LIKE '%verdict_results.json%' ORDER BY started_at DESC`,
      [datasetId]
    );
    let processed = 0;
    for (const row of rows) {
      try {
        const artifacts = typeof row.artifacts_json === 'string' ? JSON.parse(row.artifacts_json) : row.artifacts_json;
        if (!Array.isArray(artifacts)) continue;
        await this._processTestResults(datasetId, artifacts, null);
        processed++;
      } catch (err) {
        console.warn('[Orchestrator] reprocessVerdictsFromDB error:', err.message);
      }
    }
    return { processed };
  }

  async _processTestResults(datasetId, artifacts, hypothesisId = null) {
    const { dbManager, broadcast } = this.deps;
    if (!dbManager) return;

    const resolvedIds = new Set();

    // Path 0 — direct verdict file: verdict_results.json written by the skill with explicit hypothesis_id → verdict
    const verdictArtifact = (artifacts || []).find(a => {
      const name = typeof a === 'string' ? a : (a.name || a.path || '');
      return name === 'verdict_results.json' || name.endsWith('/verdict_results.json');
    });
    if (verdictArtifact?.content) {
      try {
        const verdictData = JSON.parse(verdictArtifact.content);
        let updated = 0;
        for (const item of verdictData) {
          if (!['supported', 'rejected', 'needs_more_data'].includes(item.verdict)) continue;
          // Resolve target hypothesis ID: numeric from JSON > job-context integer > text lookup
          let targetId = (typeof item.hypothesis_id === 'number') ? item.hypothesis_id : null;
          if (!targetId && hypothesisId) targetId = hypothesisId;
          if (!targetId && item.hypothesis_text) {
            const found = await dbManager.getHypothesisByText(item.hypothesis_text);
            if (found) targetId = found.hypothesis_id;
          }
          if (!targetId) continue;
          await dbManager.updateHypothesis(targetId, {
            status: item.verdict,
            actual_importance: item.actual_importance ?? null,
            evaluation_reasoning: item.reasoning || null,
          });
          resolvedIds.add(targetId);
          updated++;
        }
        if (updated > 0) {
          broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses' });
          console.log(`[Orchestrator] Updated ${updated} hypothesis verdicts via verdict_results.json for dataset ${datasetId}`);
        }
      } catch (err) {
        console.warn('[Orchestrator] _processTestResults (verdict file) error:', err.message);
      }
    }

    // Path A — feature importance: numeric comparison for hypotheses with feature_name
    const importanceArtifact = (artifacts || []).find(a => {
      const name = typeof a === 'string' ? a : (a.name || a.path || '');
      return name === 'feature_importance_results.json' || name.endsWith('/feature_importance_results.json');
    });
    if (importanceArtifact?.content) {
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
          resolvedIds.add(hyp.hypothesis_id);
          updated++;
        }

        if (updated > 0) {
          broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses' });
          console.log(`[Orchestrator] Updated ${updated} hypothesis verdicts via feature importance for dataset ${datasetId}`);
        }
      } catch (err) {
        console.warn('[Orchestrator] _processTestResults (feature importance) error:', err.message);
      }
    }

    // Path B — report-based fallback: use Claude to read report.md for the specific hypothesis
    if (hypothesisId && !resolvedIds.has(hypothesisId)) {
      try {
        const reportArtifact = (artifacts || []).find(a => {
          const name = typeof a === 'string' ? a : (a.name || a.path || '');
          const basename = name.includes('/') ? name.split('/').pop() : name;
          return basename === 'report.md';
        });
        if (reportArtifact?.content) {
          const hyp = await dbManager.getHypothesis(hypothesisId);
          if (hyp && !['supported', 'rejected'].includes(hyp.status)) {
            const verdict = await evaluateHypothesisFromReport(hyp, reportArtifact.content);
            if (verdict) {
              await dbManager.updateHypothesis(hypothesisId, {
                status: verdict.status,
                evaluation_reasoning: verdict.reasoning,
              });
              resolvedIds.add(hypothesisId);
              broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses' });
              console.log(`[Orchestrator] Hypothesis ${hypothesisId} → ${verdict.status} via report.md`);
            }
          }
        }
      } catch (err) {
        console.warn('[Orchestrator] _processTestResults (report-based) error:', err.message);
      }
    }

    // Extract conclusion text from report.md and store on all resolved hypotheses
    if (resolvedIds.size > 0) {
      try {
        const reportArtifact = (artifacts || []).find(a => {
          const name = typeof a === 'string' ? a : (a.name || a.path || '');
          return (name.includes('/') ? name.split('/').pop() : name) === 'report.md';
        });
        if (reportArtifact?.content) {
          const conclusion = extractConclusionFromReport(reportArtifact.content);
          if (conclusion) {
            for (const id of resolvedIds) {
              await dbManager.updateHypothesis(id, { conclusion_text: conclusion });
            }
            broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses' });
          }
        }
      } catch (err) {
        console.warn('[Orchestrator] _processTestResults (conclusion extraction) error:', err.message);
      }
    }
  }

  async _retryStage(stageId, datasetId, hypothesisId) {
    const stage = PIPELINE_STAGES.find(s => s.id === stageId);
    if (!stage) return;
    if (hypothesisId && this.deps.dbManager) {
      const hyp = await this.deps.dbManager.getHypothesis(hypothesisId);
      if (hyp) { await this._runStage(stage, { datasetId, hypothesis: hyp }); return; }
    }
    await this._runStage(stage, { datasetId });
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

  _broadcastStageUpdate(stageId, stageName, status, jobId, datasetId, detail) {
    if (this.deps?.broadcast) {
      this.deps.broadcast({
        type: 'PIPELINE_STAGE_UPDATE',
        stageId,
        stageName,
        status,
        jobId: jobId || null,
        datasetId: datasetId || null,
        detail: detail || null,
        autoMode: this.autoMode
      });
    }
  }
}

module.exports = new Orchestrator();
