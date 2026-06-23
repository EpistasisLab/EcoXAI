'use strict';

const path = require('path');
const wikiService = require('./wikiService');

function findArtifactByName(artifacts, filename) {
  return artifacts.find(a => {
    const n = a.name || '';
    return n === filename || path.basename(n) === filename;
  });
}

/**
 * @param {Object} deps
 * @param {string} jobId
 * @param {Object} [options]
 */
async function startJobExecution(deps, jobId, options = {}) {
  const { state, findJob, updateJob, broadcast, saveState, containerManager, volumeManager } = deps;

  const job = findJob(jobId);
  if (!job) return { success: false, error: 'Job not found', status: 404 };

  if (job.status === 'in-progress' || containerManager.isJobRunning(jobId)) {
    return { success: false, error: 'Job is already running', status: 400 };
  }

  if (!job.prompt) {
    return { success: false, error: 'Job has no prompt defined', status: 400 };
  }

  const hasFoundryConfig = process.env.CLAUDE_CODE_USE_FOUNDRY === '1' && process.env.ANTHROPIC_FOUNDRY_API_KEY;
  const hasDirectConfig = process.env.ANTHROPIC_API_KEY;
  if (!hasFoundryConfig && !hasDirectConfig) {
    return { success: false, error: 'API key not configured. Set ANTHROPIC_API_KEY or Azure Foundry variables.', status: 500 };
  }

  const budgetLimitUsd = state.settings?.budgetLimitUsd ?? 10;
  const spentUsd = state.budget?.totalCostUsd ?? 0;
  if (spentUsd >= budgetLimitUsd) {
    return {
      success: false,
      error: `Budget limit of $${budgetLimitUsd.toFixed(2)} reached (spent: $${spentUsd.toFixed(2)}). Reset the budget or raise the limit in Settings.`,
      status: 402,
    };
  }

  // Only enforce parallel limit for analyze (hypothesis test & validation) jobs
  if (job._stageId === 'analyze') {
    const maxParallelJobs = state.settings?.maxParallelJobs ?? 3;
    const runningAnalyzeCount = state.jobs.filter(j => j.status === 'in-progress' && j._stageId === 'analyze').length;
    if (runningAnalyzeCount >= maxParallelJobs) {
      return {
        success: false,
        error: `Max parallel analyze jobs (${maxParallelJobs}) already running. Wait for a job to finish or raise the limit in Settings.`,
        status: 429,
      };
    }
  }

  try {
    await volumeManager.createWorkspaceVolume(jobId);

    updateJob(jobId, {
      status: 'in-progress',
      startedAt: new Date().toISOString(),
      output: '',
      artifacts: [],
      exitCode: null
    });

    broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });

    containerManager.runJob(
      job,
      state,
      (chunk) => {
        const updatedJob = findJob(jobId);
        if (updatedJob) {
          updatedJob.output += chunk;
          broadcast({ type: 'JOB_OUTPUT', jobId, chunk });
        }
      },
      (result) => {
        // Strip in-memory Buffers before serializing to state
        const artifactsForState = result.artifacts.map(({ buffer, ...rest }) => rest);

        updateJob(jobId, {
          status: result.exitCode === 0 ? 'completed' : 'failed',
          exitCode: result.exitCode,
          artifacts: artifactsForState,
          skillsInvoked: result.skillsInvoked || [],
          completedAt: new Date().toISOString(),
          totalCostUsd: result.totalCostUsd ?? null,
          numTurns: result.numTurns ?? null,
        });

        // Save assets to local folder (pass original artifacts with binary buffers)
        const completedJob = findJob(jobId);
        const assetManager = require('./assetManager');
        const savePromise = assetManager.saveJobAssets({
          job: completedJob,
          artifacts: result.artifacts,
          sessionLog: completedJob?.output || '',
        }).catch(err => console.warn(`[Assets] Save failed for ${jobId}:`, err.message));

        // Accumulate budget
        if (result.totalCostUsd != null) {
          if (!state.budget) state.budget = { totalCostUsd: 0, jobCount: 0 };
          state.budget.totalCostUsd = +(((state.budget.totalCostUsd || 0) + result.totalCostUsd).toFixed(6));
          state.budget.jobCount = (state.budget.jobCount || 0) + 1;
          saveState();
          broadcast({ type: 'BUDGET_UPDATE', budget: state.budget });
        }

        broadcast({ type: 'JOB_COMPLETED', jobId, exitCode: result.exitCode, artifacts: result.artifacts });
        broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });

        console.log(`✓ Job ${jobId} completed with exit code ${result.exitCode} | cost: $${result.totalCostUsd?.toFixed(4) ?? 'n/a'} | turns: ${result.numTurns ?? 'n/a'}`);

        // Notify orchestrator of job completion (orchestrator handles volume deletion)
        if (deps.orchestrator) {
          const completedJob = findJob(jobId);
          deps.orchestrator.emit('job_completed', {
            jobId,
            exitCode: result.exitCode,
            datasetId: completedJob?.datasetId || null,
            stageId: completedJob?._stageId || null,
            artifacts: result.artifacts
          });
        } else {
          // No orchestrator — delete workspace volume once assets are saved
          savePromise.then(() => volumeManager.deleteWorkspaceVolume(jobId))
            .catch(err => console.warn(`[Volume] Cleanup failed for ${jobId}:`, err.message));
        }

        // Async wiki update — file discovery then refresh portrait
        if (completedJob?.datasetId && state.datasets[completedJob.datasetId]) {
          const datasetId = completedJob.datasetId;
          const datasetMeta = state.datasets[datasetId];

          const reportArtifact = findArtifactByName(result.artifacts, 'report.md')
            || findArtifactByName(result.artifacts, 'exploration_report.md');
          const reportContent = reportArtifact?.content || null;

          let featureData = null;
          const featureArtifact = findArtifactByName(result.artifacts, 'feature_importance_results.json');
          if (featureArtifact?.content) {
            try { featureData = JSON.parse(featureArtifact.content); } catch (_) {}
          }

          wikiService.fileDiscovery(datasetId, completedJob.id, completedJob.title, reportContent, featureData)
            .then(() => volumeManager.readDatasetContext(datasetId))
            .then(ctx => wikiService.refreshPortrait(datasetId, datasetMeta, ctx))
            .then(() => broadcast({ type: 'WIKI_UPDATE', datasetId }))
            .catch(err => console.warn(`[Wiki] Update failed:`, err.message));
        }
      },
      (error) => {
        updateJob(jobId, { status: 'failed', exitCode: -1, completedAt: new Date().toISOString() });
        broadcast({ type: 'JOB_FAILED', jobId, error: error.message });
        broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
        console.error(`Job ${jobId} failed:`, error.message);
        // Cleanup workspace volume on failure
        volumeManager.deleteWorkspaceVolume(jobId)
          .catch(err => console.warn(`[Volume] Cleanup failed for ${jobId}:`, err.message));
      },
      // onHypothesesExtracted callback
      (hypotheses) => {
        broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses', jobId });
        if (deps.orchestrator) {
          deps.orchestrator.emit('hypotheses_extracted', {
            jobId,
            datasetId: findJob(jobId)?.datasetId || null,
            count: hypotheses?.length || 0
          });
        }
      }
    );

    return { success: true };
  } catch (error) {
    updateJob(jobId, { status: 'failed' });
    return { success: false, error: error.message, status: 500 };
  }
}

module.exports = { startJobExecution };
