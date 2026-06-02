/**
 * Confidence Scorer (Stage 4)
 *
 * Scores extraction quality and applies thresholds.
 * Artifacts with confidence < threshold are EXCLUDED (fail closed).
 */

const fs = require('fs').promises;

/**
 * Score confidence for all artifacts
 *
 * @param {Object} structure - Structure analysis from Stage 1
 * @param {Object} contentResult - Content normalization from Stage 2
 * @param {Object} semantic - Semantic metadata from Stage 3
 * @param {number} threshold - Minimum confidence threshold (default 0.9)
 * @returns {Promise<Object>} Confidence scores
 */
async function score(structure, contentResult, semantic, threshold = 0.9) {
  const artifactScores = {};
  const exclusions = [];

  // Score each artifact
  for (const artifact of contentResult.artifacts) {
    let confidence;

    if (artifact.type === 'table') {
      confidence = await scoreTableArtifact(artifact, structure, semantic);
    } else if (artifact.type === 'narrative') {
      confidence = await scoreNarrativeArtifact(artifact, structure, semantic);
    } else {
      confidence = {
        overall: 0.5,
        method: 'unknown_type'
      };
    }

    artifactScores[artifact.id] = confidence;

    // Check threshold
    if (confidence.overall < threshold) {
      exclusions.push({
        artifact: artifact.id,
        reason: `confidence ${confidence.overall.toFixed(2)} < ${threshold} threshold`,
        confidence: confidence.overall,
        recommendation: 'Manual review required'
      });
    }
  }

  // Compute overall confidence (weighted average)
  const overallConfidence = computeOverallConfidence(artifactScores, contentResult.artifacts);

  return {
    overall: overallConfidence,
    artifacts: artifactScores,
    exclusions,
    threshold
  };
}

/**
 * Score table artifact
 */
async function scoreTableArtifact(artifact, structure, semantic) {
  const scores = {
    overall: 1.0,
    headers: 1.0,
    numeric_parsing: 1.0,
    unit_inference: 1.0,
    missing_values_handled: true,
    method: 'rule_based'
  };

  try {
    // Load table metadata
    if (artifact.metadata_path) {
      const metadataContent = await fs.readFile(artifact.metadata_path, 'utf8');
      const metadata = JSON.parse(metadataContent);

      // Score headers (check for empty or generic names)
      const columns = metadata.columns;
      const emptyHeaders = columns.filter(c => !c.name || c.name.trim().length === 0);
      const genericHeaders = columns.filter(c => /^(column|field|unnamed|col)\d*$/i.test(c.name));

      if (emptyHeaders.length > 0) {
        scores.headers -= 0.1 * (emptyHeaders.length / columns.length);
      }

      if (genericHeaders.length > 0) {
        scores.headers -= 0.05 * (genericHeaders.length / columns.length);
      }

      scores.headers = Math.max(0.0, scores.headers);

      // Score numeric parsing (check if numeric columns were detected)
      const numericColumns = columns.filter(c => c.dtype === 'int64' || c.dtype === 'float64');

      if (numericColumns.length === 0 && columns.length > 1) {
        // Probably should have some numeric columns
        scores.numeric_parsing = 0.8;
      }

      // Score unit inference (check if units are in semantic metadata)
      const hasUnits = Object.keys(semantic.units || {}).length > 0;

      if (hasUnits) {
        const columnsWithUnits = columns.filter(c => semantic.units[c.name]);
        scores.unit_inference = columnsWithUnits.length / numericColumns.length || 0.5;
      } else {
        scores.unit_inference = 0.7; // No units detected, lower confidence
      }

      // Check missing values handling
      scores.missing_values_handled = metadata.missing_value_strategy !== undefined;

      // Compute overall score
      scores.overall = (
        scores.headers * 0.3 +
        scores.numeric_parsing * 0.3 +
        scores.unit_inference * 0.2 +
        (scores.missing_values_handled ? 0.2 : 0.0)
      );

    } else {
      // No metadata available, lower confidence
      scores.overall = 0.7;
      scores.headers = 0.7;
      scores.numeric_parsing = 0.7;
      scores.unit_inference = 0.7;
    }

  } catch (err) {
    console.warn(`[ConfidenceScorer] Failed to score table ${artifact.id}:`, err.message);
    scores.overall = 0.5;
  }

  return scores;
}

/**
 * Score narrative artifact
 */
async function scoreNarrativeArtifact(artifact, structure, semantic) {
  const scores = {
    overall: 1.0,
    text_quality: 1.0,
    structure: 1.0,
    method: 'rule_based'
  };

  try {
    // Load narrative content
    const content = await fs.readFile(artifact.path, 'utf8');

    // Score text quality (check for encoding issues, empty content)
    if (content.length === 0) {
      scores.text_quality = 0.0;
    } else if (content.includes('\ufffd')) {
      // Replacement character detected
      scores.text_quality = 0.6;
    }

    // Score structure (check for markdown headers, formatting)
    const hasHeaders = /^#{1,6}\s+/m.test(content);
    const hasLists = /^\s*[-*]\s+/m.test(content);
    const hasCodeBlocks = /```/.test(content);

    if (hasHeaders || hasLists || hasCodeBlocks) {
      scores.structure = 1.0;
    } else {
      scores.structure = 0.8; // Plain text, no structure
    }

    // Compute overall score
    scores.overall = (scores.text_quality * 0.6 + scores.structure * 0.4);

  } catch (err) {
    console.warn(`[ConfidenceScorer] Failed to score narrative ${artifact.id}:`, err.message);
    scores.overall = 0.5;
  }

  return scores;
}

/**
 * Compute overall confidence (weighted average)
 */
function computeOverallConfidence(artifactScores, artifacts) {
  if (artifacts.length === 0) {
    return 0.0;
  }

  // Weight by artifact size (larger artifacts have more weight)
  const weights = {};
  let totalWeight = 0;

  for (const artifact of artifacts) {
    const size = artifact.row_count || artifact.line_count || 1;
    weights[artifact.id] = size;
    totalWeight += size;
  }

  // Weighted average
  let weightedSum = 0;

  for (const artifact of artifacts) {
    const score = artifactScores[artifact.id]?.overall || 0.0;
    const weight = weights[artifact.id] / totalWeight;

    weightedSum += score * weight;
  }

  return weightedSum;
}

module.exports = {
  score
};
