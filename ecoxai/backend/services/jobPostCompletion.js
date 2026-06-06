/**
 * jobPostCompletion.js — Shared post-completion logic for both Docker and HPC paths.
 *
 * Handles hypothesis extraction, feature importance parsing, memory updates,
 * and hypothesis edge creation after a job completes.
 */

'use strict';

const path = require('path');
const dbManager = require('./databaseManager');

// ── Anthropic client (lazy-initialized on first use) ──────────────────────────

let anthropic = null;

function getAnthropicClient() {
  if (anthropic) return anthropic;

  const useFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY === '1';

  if (useFoundry) {
    const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
    const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE || 'cbm-staff-gpt4';
    if (apiKey) {
      try {
        const AnthropicFoundry = require('@anthropic-ai/foundry-sdk').default;
        anthropic = new AnthropicFoundry({ apiKey, resource });
        return anthropic;
      } catch (e) {
        console.warn('[jobPostCompletion] Foundry SDK unavailable, falling back to direct API:', e.message);
      }
    }
  }

  // Direct Anthropic API (default or Foundry fallback)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const opts = { apiKey };
    if (process.env.ANTHROPIC_BASE_URL) opts.baseURL = process.env.ANTHROPIC_BASE_URL;
    anthropic = new Anthropic(opts);
  } catch (e) {
    console.warn('[jobPostCompletion] Anthropic SDK unavailable:', e.message);
  }

  return anthropic;
}

function getModel() {
  if (process.env.CLAUDE_CODE_USE_FOUNDRY === '1') {
    return process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-5';
  }
  return process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20241022';
}

// ── Standalone helpers ─────────────────────────────────────────────────────────

/** Read text-based artifact files from a Docker workspace volume. */
async function readArtifactsFromVolume(jobId, artifactsJson) {
  if (!jobId || !artifactsJson) return [];

  try {
    const artifacts = typeof artifactsJson === 'string' ? JSON.parse(artifactsJson) : artifactsJson;
    if (!Array.isArray(artifacts) || artifacts.length === 0) return [];

    const textExtensions = ['.md', '.txt', '.json', '.csv', '.log'];
    const textArtifacts = artifacts.filter(a =>
      textExtensions.some(ext => (a.name || '').toLowerCase().endsWith(ext))
    );
    if (textArtifacts.length === 0) return [];

    const Docker = require('dockerode');
    const docker = new Docker();
    const results = [];

    for (const artifact of textArtifacts) {
      try {
        const container = await docker.createContainer({
          Image: 'alpine',
          Cmd: ['cat', artifact.actualPath || artifact.path],
          HostConfig: {
            Binds: [`ecoxai-workspace-${jobId}:/workspace:ro`],
            AutoRemove: false
          }
        });

        await container.start();
        await container.wait();
        const logs = await container.logs({ stdout: true, stderr: false });
        const content = logs.toString('utf8');
        await container.remove().catch(() => {});

        if (content.length > 0) {
          results.push({
            name: artifact.name,
            content: content.length < 50000 ? content.trim() : content.substring(0, 50000) + '\n\n[... truncated ...]'
          });
        }
      } catch (e) {
        console.warn(`[readArtifactsFromVolume] Failed to read ${artifact.name}:`, e.message);
      }
    }

    return results;
  } catch (e) {
    console.error('[readArtifactsFromVolume] Error:', e);
    return [];
  }
}

/** Extract JSON from an AI response — handles markdown fences, trailing commas, incomplete JSON. */
function extractJSON(responseText) {
  let cleaned = responseText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');

  const fix = (s) => s
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/:\s*0\./g, ': 0.0')
    .replace(/:\s*(\d+)\./g, ': $1.0')
    .replace(/:\s*0\.\s*[,\n}]/g, ': 0.0$1');

  const tryComplete = (jsonStr) => {
    let s = jsonStr.trim();
    const ends = [];
    for (let i = 0; i < s.length; i++) if (s[i] === '}') ends.push(i);

    for (let i = ends.length - 1; i >= 0; i--) {
      let candidate = s.substring(0, ends[i] + 1);
      const ob = (candidate.match(/\{/g) || []).length;
      const cb = (candidate.match(/\}/g) || []).length;
      const oa = (candidate.match(/\[/g) || []).length;
      const ca = (candidate.match(/\]/g) || []).length;
      for (let j = 0; j < oa - ca; j++) candidate += ']';
      for (let j = 0; j < ob - cb; j++) candidate += '}';
      try { JSON.parse(candidate); return candidate; } catch (e) { /* continue */ }
    }

    const ob = (s.match(/\{/g) || []).length;
    const cb = (s.match(/\}/g) || []).length;
    const oa = (s.match(/\[/g) || []).length;
    const ca = (s.match(/\]/g) || []).length;
    for (let i = 0; i < oa - ca; i++) s += ']';
    for (let i = 0; i < ob - cb; i++) s += '}';
    return s;
  };

  const tryParse = (raw) => {
    const fixed = fix(raw);
    try { JSON.parse(fixed); return fixed; } catch (e) { /* fall through */ }
    const completed = tryComplete(fixed);
    try { JSON.parse(completed); return completed; } catch (e) { return null; }
  };

  // Try markdown code block first
  if (cleaned.includes('```')) {
    const m = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (m && m[1]) {
      const result = tryParse(m[1].trim());
      if (result) return result;
    }
  }

  // Try bare JSON object
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const result = tryParse(objMatch[0]);
    if (result) return result;
  }

  // Try bare JSON array
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const result = tryParse(arrMatch[0]);
    if (result) return result;
  }

  return tryParse(cleaned.trim());
}

// ── findArtifactByName ─────────────────────────────────────────────────────────

/** Find an artifact by filename (basename match, since name may be a relative path) */
function findArtifactByName(artifacts, filename) {
  return artifacts.find(a => {
    const n = a.name || '';
    return n === filename || path.basename(n) === filename;
  });
}

// ── processJobCompletion ───────────────────────────────────────────────────────

/**
 * Process a completed job's artifacts for hypotheses, feature importance, and memory.
 *
 * @param {Object} opts
 * @param {string} opts.jobId
 * @param {string} opts.runId
 * @param {Object} opts.job - The job object
 * @param {Array}  opts.artifacts - Collected artifacts
 * @param {number} opts.exitCode
 * @param {Function} [opts.onHypothesesExtracted] - Callback for hypothesis extraction events
 */
async function processJobCompletion({
  jobId, runId, job, artifacts, exitCode,
  onHypothesesExtracted
}) {
  if (exitCode !== 0) return;

  // 1. Hypotheses are written live by the agent via POST /api/hypotheses during execution.
  //    Just count what was stored and fire the callback to advance the pipeline.
  try {
    const count = dbManager.countHypothesesForRun(runId);
    if (count > 0) {
      console.log(`[${jobId}] ${count} hypotheses stored via API during job execution`);
      if (typeof onHypothesesExtracted === 'function') {
        onHypothesesExtracted({ runId, jobId, count });
      }
    } else {
      console.log(`[${jobId}] No hypotheses found for run ${runId}`);
    }
  } catch (hypothesisError) {
    console.warn(`[${jobId}] Failed to count hypotheses:`, hypothesisError.message);
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

/**
 * Evaluate a hypothesis verdict by asking Claude to read the analyze job's report.md.
 * Used as a fallback for hypotheses that cannot be evaluated via feature-importance numerics.
 *
 * @param {Object} hypothesis - Full hypothesis row from the database
 * @param {string} reportContent - Content of report.md from the analyze job
 * @returns {Promise<{status: string, reasoning: string}|null>}
 */
async function evaluateHypothesisFromReport(hypothesis, reportContent) {
  const client = getAnthropicClient();
  if (!client) return null;

  const metricHint = hypothesis.expected_metric
    ? `\nExpected metric: ${hypothesis.expected_metric}`
    : '';

  const userPrompt = `You are evaluating whether a scientific hypothesis was supported or rejected based on an analysis report.

Hypothesis: "${hypothesis.hypothesis_text}"
Hypothesis type: ${hypothesis.hypothesis_type || 'unknown'}${metricHint}

Analysis report:
---
${reportContent.substring(0, 8000)}
---

Based solely on the evidence in the report, determine the verdict for this hypothesis.

Return ONLY a JSON object:
{
  "status": "supported" | "rejected" | "needs_more_data",
  "reasoning": "<1-2 sentences citing specific evidence from the report>"
}`;

  try {
    const message = await client.messages.create({
      model: getModel(),
      max_tokens: 256,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const responseText = message.content[0]?.text?.trim() ?? '';
    const jsonText = extractJSON(responseText);
    if (!jsonText) return null;

    const parsed = JSON.parse(jsonText);
    const status = parsed.status;
    if (!['supported', 'rejected', 'needs_more_data'].includes(status)) return null;

    return { status, reasoning: parsed.reasoning || '' };
  } catch (err) {
    console.warn('[jobPostCompletion] evaluateHypothesisFromReport failed:', err.message);
    return null;
  }
}

module.exports = { processJobCompletion, evaluateHypothesisFromReport };
