/**
 * jobPostCompletion.js — Shared post-completion logic for both Docker and HPC paths.
 *
 * Handles hypothesis extraction, feature importance parsing, memory updates,
 * and hypothesis edge creation after a job completes.
 */

'use strict';

const path = require('path');
const dbManager = require('./databaseManager');

/** Find an artifact by filename (basename match, since name may be a relative path) */
function findArtifactByName(artifacts, filename) {
  return artifacts.find(a => {
    const n = a.name || '';
    return n === filename || path.basename(n) === filename;
  });
}

/**
 * Process a completed job's artifacts for hypotheses, feature importance, and memory.
 *
 * @param {Object} opts
 * @param {string} opts.jobId
 * @param {string} opts.runId
 * @param {Object} opts.job - The job object
 * @param {Array}  opts.artifacts - Collected artifacts
 * @param {number} opts.exitCode
 * @param {Object} opts.storageService
 * @param {Object} opts.state - Global state
 * @param {Function} [opts.onHypothesesExtracted] - Callback for hypothesis extraction events
 */
async function processJobCompletion({
  jobId, runId, job, artifacts, exitCode,
  storageService, state, onHypothesesExtracted
}) {
  if (exitCode !== 0) return;

  // 1. Check for next_hypothesis.json → parse → insert into database
  try {
    const hypothesisAgent = require('./hypothesisAgent');
    const nextHypothesisArtifact = findArtifactByName(artifacts, 'next_hypothesis.json');

    if (nextHypothesisArtifact && nextHypothesisArtifact.content) {
      console.log(`[${jobId}] Found next_hypothesis.json, inserting directly into database`);

      const hypothesisData = JSON.parse(nextHypothesisArtifact.content);

      let hypotheses = [];

      if (Array.isArray(hypothesisData)) {
        hypotheses = hypothesisData;
      } else if (hypothesisData.hypotheses && Array.isArray(hypothesisData.hypotheses)) {
        hypotheses = hypothesisData.hypotheses;
      }

      if (hypotheses.length > 0) {
        let insertedCount = 0;
        for (const hyp of hypotheses) {
          // hypothesis_text is NOT NULL in the DB. Skip malformed entries so one
          // bad item doesn't abort the whole batch (previously the loop threw and
          // every hypothesis for the run was lost).
          if (typeof hyp.hypothesis_text !== 'string' || !hyp.hypothesis_text.trim()) {
            console.warn(`[${jobId}] Skipping hypothesis with missing hypothesis_text`);
            continue;
          }

          let priority = 1000;
          if (typeof hyp.confidence_score === 'number') {
            const clampedConfidence = Math.max(0, Math.min(1, hyp.confidence_score));
            priority = Math.floor(1000 - (clampedConfidence * 900));
          }

          // Per-item try/catch: a single failed insert must not drop the rest.
          try {
            await dbManager.createHypothesis({
              run_id: runId,
              turn_number: hyp.turn_number || 1,
              hypothesis_text: hyp.hypothesis_text,
              hypothesis_type: hyp.hypothesis_type || null,
              confidence_score: hyp.confidence_score || null,
              status: 'proposed',
              expected_importance: hyp.expected_importance || null,
              expected_metric: hyp.expected_metric || null,
              alzkb_source: hyp.alzkb_source || null,
              feature_name: hyp.feature_name || null,
              priority
            });
            insertedCount++;
          } catch (insertErr) {
            console.warn(`[${jobId}] Failed to insert one hypothesis:`, insertErr.message);
          }
        }

        console.log(`[${jobId}] Inserted ${insertedCount}/${hypotheses.length} hypotheses from next_hypothesis.json`);

        if (typeof onHypothesesExtracted === 'function') {
          onHypothesesExtracted({
            runId, jobId,
            count: insertedCount,
          });
        }
      } else {
        console.log(`[${jobId}] next_hypothesis.json contains no hypotheses`);
      }

    } else if (hypothesisAgent.hasAIMode()) {
      // 2. Fallback: AI-based extraction from thinking blocks
      console.log(`[${jobId}] Auto-extracting hypotheses from run ${runId}`);

      const hypothesisConfig = job.datasetId && state?.datasets?.[job.datasetId]?.hypothesisConfig;

      const extractedHypotheses = await hypothesisAgent.extractHypotheses(runId, {
        hypothesisConfig
      });

      if (extractedHypotheses.length > 0) {
        console.log(`[${jobId}] Extracted ${extractedHypotheses.length} hypotheses`);

        if (typeof onHypothesesExtracted === 'function') {
          onHypothesesExtracted({
            runId, jobId,
            count: extractedHypotheses.length,
            hypotheses: extractedHypotheses
          });
        }
      } else {
        console.log(`[${jobId}] No hypotheses found in thinking blocks`);
      }
    }
  } catch (hypothesisError) {
    console.warn(`[${jobId}] Failed to auto-extract hypotheses:`, hypothesisError.message);
  }

  // 3. Parse feature importance results
  try {
    const featureImportanceArtifact = findArtifactByName(artifacts, 'feature_importance_results.json');
    if (featureImportanceArtifact && featureImportanceArtifact.content) {
      console.log(`[${jobId}] Parsing feature importance results`);

      const results = JSON.parse(featureImportanceArtifact.content);

      if (job.datasetId && results.features) {
        const hypothesisId = job.testingHypothesisId || null;

        for (const [featureName, importanceScore] of Object.entries(results.features)) {
          await dbManager.insertFeatureImportanceResult({
            dataset_id: job.datasetId,
            run_id: runId,
            hypothesis_id: hypothesisId,
            feature_name: featureName,
            importance_score: importanceScore,
            model_type: results.model_type || null,
            model_auc: results.model_auc || null,
            model_accuracy: results.model_accuracy || null
          });
        }

        console.log(`[${jobId}] Stored ${Object.keys(results.features).length} feature importance results`);

        if (hypothesisId) {
          await _updateHypothesisWithResults(hypothesisId, results);
        }
      }
    }
  } catch (featureImportanceError) {
    console.warn(`[${jobId}] Failed to parse feature importance results:`, featureImportanceError.message);
  }

  // 4. Advance hypothesis from test_requested → evidence_collected if still stuck
  try {
    const hypothesisId = job.testingHypothesisId;
    if (hypothesisId) {
      const hypothesis = await dbManager.getHypothesis(hypothesisId);
      if (hypothesis && hypothesis.status === 'test_requested') {
        await dbManager.updateHypothesis(hypothesisId, { status: 'evidence_collected' });
        console.log(`[${jobId}] Advanced hypothesis ${hypothesisId} from test_requested to evidence_collected`);
      }
    }
  } catch (hypAdvanceError) {
    console.warn(`[${jobId}] Failed to advance hypothesis status:`, hypAdvanceError.message);
  }
}

/**
 * Update hypothesis actual_importance and auto-evaluate.
 */
async function _updateHypothesisWithResults(hypothesisId, results) {
  try {
    const hypothesis = await dbManager.getHypothesis(hypothesisId);
    if (!hypothesis) return;

    const featureName = hypothesis.feature_name;
    if (featureName && results.features && results.features[featureName] !== undefined) {
      const actualImportance = results.features[featureName];
      await dbManager.updateHypothesis(hypothesisId, {
        actual_importance: actualImportance
      });

      // Auto-evaluate if we have expected importance
      if (hypothesis.expected_importance !== null) {
        const supported = actualImportance >= hypothesis.expected_importance;
        await dbManager.updateHypothesis(hypothesisId, {
          status: supported ? 'supported' : 'rejected',
          evaluation_reasoning: `Actual importance (${actualImportance.toFixed(4)}) ${supported ? '>=' : '<'} expected (${hypothesis.expected_importance})`
        });
      }
    }
  } catch (err) {
    console.warn(`[jobPostCompletion] Failed to update hypothesis ${hypothesisId}:`, err.message);
  }
}

module.exports = { processJobCompletion };
