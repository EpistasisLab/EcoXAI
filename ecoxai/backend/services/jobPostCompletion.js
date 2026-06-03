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
    if (!apiKey) return null;
    try {
      const AnthropicFoundry = require('@anthropic-ai/foundry-sdk').default;
      anthropic = new AnthropicFoundry({ apiKey, resource });
    } catch (e) {
      console.warn('[jobPostCompletion] Foundry SDK unavailable:', e.message);
    }
  } else {
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

/** Filter extracted hypotheses by featureImportance/featureEngineering config. */
function filterHypothesesByConfig(hypotheses, config) {
  if (config.featureImportance === 100 && config.featureEngineering === 0) {
    return hypotheses.filter(h => h.hypothesis_type !== 'feature_engineering');
  }
  if (config.featureEngineering === 100 && config.featureImportance === 0) {
    return hypotheses.filter(h => h.hypothesis_type === 'feature_engineering');
  }
  return hypotheses;
}

/**
 * Fallback: extract hypotheses from a run's thinking blocks and artifacts via the Claude API.
 * Only called when the agent did not produce a next_hypothesis.json artifact.
 */
async function extractHypothesesFromRun(runId, options = {}) {
  const { datasetDomain, hypothesisConfig } = options;
  const client = getAnthropicClient();
  if (!client) return [];

  try {
    const run = await dbManager.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const thinkingBlocks = await dbManager.getStepsForRun(runId, 'thinking');
    const toolCalls = await dbManager.getToolCallsForRun(runId);
    const toolSummary = toolCalls.map(t => `${t.tool_name} (turn ${t.turn_number})`).join(', ');
    const artifactContents = await readArtifactsFromVolume(run.job_id, run.artifacts_json);

    if (thinkingBlocks.length === 0 && artifactContents.length === 0) return [];

    const isGenomic = datasetDomain === 'genomics';

    const systemPrompt = `You are a machine learning feature engineering specialist analyzing an AI agent's analysis.

Your task is to extract FEATURE IMPORTANCE HYPOTHESES and MODEL BUILDING INSIGHTS from the agent's outputs (reports, analysis files) and reasoning trace.

${isGenomic ? `**GENOMIC DATASET MODE:**
1. Frame discoveries as "Feature X will have importance > Y in predicting outcome Z"
2. Use multi-hop reasoning to build on previous findings
3. Extract feature importance scores, model metrics, predictive features
` : `**MODEL BUILDING MODE:**
1. Extract feature importance scores, model performance metrics from outputs
2. Frame discoveries as "Feature X will have importance > Y in predicting outcome Z"
3. Extract actual importance scores, AUC, accuracy, F1 metrics
`}
Requirements:
1. **PRIMARY SOURCE**: Extract from generated outputs (reports, analysis files)
2. **SECONDARY SOURCE**: If outputs don't contain hypotheses, use thinking blocks
3. Extract 2-4 feature-focused hypotheses
4. Hypotheses must be TESTABLE with concrete metrics
5. Each hypothesis must have a confidence score (0.0-1.0)

Return ONLY a JSON object:
{
  "hypotheses": [
    {
      "hypothesis_text": "Feature-focused claim with expected importance/performance metric",
      "hypothesis_type": "feature_importance" | "model_performance" | "feature_engineering" | "predictive",
      "confidence_score": 0.0-1.0,
      "expected_importance": 0.0-1.0 or null,
      "expected_metric": "AUC > 0.8" or "importance > 0.15" or null,
      "graph_source": null,
      "turn_number": <integer>
    }
  ],
  "relationships": []
}

If no valid hypotheses can be extracted, return: {"hypotheses": [], "relationships": []}`;

    const thinkingContent = thinkingBlocks
      .map(b => `[Turn ${b.step_number}]\n${b.output || b.input || ''}`)
      .join('\n\n');

    const artifactContent = artifactContents.length > 0
      ? artifactContents.map(a => `[File: ${a.name}]\n${a.content}`).join('\n\n')
      : 'None';

    const userPrompt = `Original task: "${run.prompt}"

${thinkingBlocks.length > 0 ? `Thinking blocks (agent reasoning):\n${thinkingContent}\n\n` : ''}${artifactContents.length > 0 ? `Generated outputs:\n${artifactContent}\n\n` : ''}Tools used: ${toolSummary || 'None'}

Extract falsifiable hypotheses from ${artifactContents.length > 0 ? 'the generated outputs and reasoning' : 'this reasoning trace'}.`;

    const message = await client.messages.create({
      model: getModel(),
      max_tokens: 2000,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt
    });

    const responseText = message.content[0].text.trim();
    const jsonText = extractJSON(responseText);
    if (!jsonText) throw new Error('Could not find valid JSON in AI response');

    const parsed = JSON.parse(jsonText);
    let hypotheses = Array.isArray(parsed)
      ? parsed
      : (parsed.hypotheses && Array.isArray(parsed.hypotheses) ? parsed.hypotheses : []);

    if (hypothesisConfig) {
      hypotheses = filterHypothesesByConfig(hypotheses, hypothesisConfig);
    }

    const inserted = [];
    for (const hyp of hypotheses) {
      const confidence = hyp.confidence_score;
      const priority = (typeof confidence === 'number')
        ? Math.floor(1000 - (Math.max(0, Math.min(1, confidence)) * 900))
        : 1000;

      const hypothesisId = await dbManager.createHypothesis({
        run_id: runId,
        turn_number: hyp.turn_number || 1,
        hypothesis_text: hyp.hypothesis_text,
        hypothesis_type: hyp.hypothesis_type,
        confidence_score: confidence,
        status: 'proposed',
        expected_importance: hyp.expected_importance || null,
        expected_metric: hyp.expected_metric || null,
        graph_source: hyp.graph_source || null,
        feature_name: hyp.feature_name || null,
        priority
      });

      inserted.push({ hypothesis_id: hypothesisId, ...hyp });
    }

    console.log(`[extractHypothesesFromRun] Extracted ${inserted.length} hypotheses from run ${runId}`);
    return inserted;

  } catch (e) {
    console.error('[extractHypothesesFromRun] Failed:', e);
    throw e;
  }
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
        for (const hyp of hypotheses) {
          let priority = 1000;
          if (typeof hyp.confidence_score === 'number') {
            const clampedConfidence = Math.max(0, Math.min(1, hyp.confidence_score));
            priority = Math.floor(1000 - (clampedConfidence * 900));
          }

          await dbManager.createHypothesis({
            run_id: runId,
            turn_number: hyp.turn_number || 1,
            hypothesis_text: hyp.hypothesis_text,
            hypothesis_type: hyp.hypothesis_type || null,
            confidence_score: hyp.confidence_score || null,
            status: 'proposed',
            expected_importance: hyp.expected_importance || null,
            expected_metric: hyp.expected_metric || null,
            graph_source: hyp.graph_source || null,
            feature_name: hyp.feature_name || null,
            priority
          });
        }

        console.log(`[${jobId}] Inserted ${hypotheses.length} hypotheses from next_hypothesis.json`);

        if (typeof onHypothesesExtracted === 'function') {
          onHypothesesExtracted({ runId, jobId, count: hypotheses.length });
        }
      } else {
        console.log(`[${jobId}] next_hypothesis.json contains no hypotheses`);
      }

    } else if (getAnthropicClient()) {
      // 2. Fallback: AI-based extraction from thinking blocks and artifacts
      console.log(`[${jobId}] Auto-extracting hypotheses from run ${runId}`);

      const hypothesisConfig = job.datasetId && state?.datasets?.[job.datasetId]?.hypothesisConfig;

      const extractedHypotheses = await extractHypothesesFromRun(runId, { hypothesisConfig });

      if (extractedHypotheses.length > 0) {
        console.log(`[${jobId}] Extracted ${extractedHypotheses.length} hypotheses`);

        if (typeof onHypothesesExtracted === 'function') {
          onHypothesesExtracted({ runId, jobId, count: extractedHypotheses.length, hypotheses: extractedHypotheses });
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
