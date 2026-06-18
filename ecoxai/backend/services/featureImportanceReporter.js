/**
 * Feature Importance Reporter
 *
 * Generates report.md files with feature importance findings and JSON output
 */

const dbManager = require('./databaseManager');

/**
 * Generate feature importance report for a dataset
 * @param {string} datasetId - Dataset ID
 * @param {number} importanceThreshold - Minimum importance to include (default: 0.10)
 * @returns {Promise<Object>} Report content and feature list
 */
async function generateFeatureImportanceReport(datasetId, importanceThreshold = 0.10) {
  try {
    // Get all hypotheses for this dataset
    const hypotheses = await dbManager.getHypothesesForDataset(datasetId);

    // Filter for feature importance hypotheses with actual importance scores
    const features = hypotheses
      .filter(h =>
        (h.hypothesis_type === 'feature_importance' || h.hypothesis_type === 'feature_engineering') &&
        h.actual_importance !== null &&
        h.actual_importance >= importanceThreshold
      )
      .sort((a, b) => (b.actual_importance || 0) - (a.actual_importance || 0)); // Sort by importance descending

    // Generate markdown report
    const markdown = generateMarkdownReport(features, importanceThreshold, datasetId);

    // Generate JSON output
    const jsonOutput = generateJSONOutput(features);

    return {
      markdown,
      json: jsonOutput,
      featureCount: features.length
    };

  } catch (error) {
    console.error('Error generating feature importance report:', error);
    throw error;
  }
}

/**
 * Generate markdown report content
 */
function generateMarkdownReport(features, threshold, datasetId) {
  const lines = [];

  lines.push('# Feature Importance Report');
  lines.push('');
  lines.push(`**Dataset:** ${datasetId}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Importance Threshold:** ${threshold}`);
  lines.push(`**Features Recorded:** ${features.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (features.length === 0) {
    lines.push('## No Features Above Threshold');
    lines.push('');
    lines.push(`No features with importance ≥ ${threshold} have been recorded yet.`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Feature Importance Rankings');
  lines.push('');

  features.forEach((feature, index) => {
    const rank = index + 1;
    const importance = (feature.actual_importance * 100).toFixed(2);
    const featureName = feature.feature_name || 'Unknown';
    const expectedImportance = feature.expected_importance ?
      (feature.expected_importance * 100).toFixed(2) : 'N/A';

    lines.push(`### ${rank}. ${featureName} (Importance: ${importance}%)`);
    lines.push('');
    lines.push(`**Hypothesis:** ${feature.hypothesis_text}`);
    lines.push('');
    lines.push(`**Type:** ${feature.hypothesis_type}`);
    lines.push(`**Status:** ${feature.status}`);
    lines.push(`**Expected Importance:** ${expectedImportance}%`);
    lines.push(`**Actual Importance:** ${importance}%`);

    if (feature.expected_metric) {
      lines.push(`**Expected Metric:** ${feature.expected_metric}`);
    }

    if (feature.graph_source) {
      lines.push(`**Source:** ${feature.graph_source}`);
    }

    if (feature.confidence_score) {
      const confidence = (feature.confidence_score * 100).toFixed(0);
      lines.push(`**Confidence:** ${confidence}%`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  });

  // Add JSON section
  lines.push('## JSON Output');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(generateJSONOutput(features), null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate JSON output for feature importance
 */
function generateJSONOutput(features) {
  return {
    generated_at: new Date().toISOString(),
    feature_count: features.length,
    features: features.map((feature, index) => ({
      rank: index + 1,
      feature_name: feature.feature_name || 'Unknown',
      importance: feature.actual_importance,
      expected_importance: feature.expected_importance,
      hypothesis: feature.hypothesis_text,
      type: feature.hypothesis_type,
      status: feature.status,
      expected_metric: feature.expected_metric,
      graph_source: feature.graph_source,
      confidence: feature.confidence_score,
      hypothesis_id: feature.hypothesis_id
    }))
  };
}

/**
 * Save report to workspace volume
 * @param {string} jobId - Job ID
 * @param {string} markdown - Markdown content
 * @param {Object} json - JSON content
 */
async function saveReportToWorkspace(jobId, markdown, json) {
  const volumeManager = require('./volumeManager');
  const ok = await volumeManager.writeWorkspaceFiles(jobId, {
    'report.md': markdown,
    'feature_importance.json': JSON.stringify(json, null, 2),
  });
  if (!ok) throw new Error(`Failed to save feature importance report to workspace ${jobId}`);
  console.log(`✓ Saved feature importance report to workspace ${jobId}`);
}

module.exports = {
  generateFeatureImportanceReport,
  saveReportToWorkspace
};
