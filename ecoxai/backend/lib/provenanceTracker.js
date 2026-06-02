/**
 * Provenance Tracker (Stage 5)
 *
 * Records lineage metadata for normalized datasets.
 * Tracks source file, extraction methods, timestamps, and pipeline version.
 */

/**
 * Track provenance metadata
 *
 * @param {string} filename - Original filename
 * @param {Object} structure - Structure analysis from Stage 1
 * @param {Object} contentResult - Content normalization from Stage 2
 * @param {Object} semantic - Semantic metadata from Stage 3
 * @param {Object} confidence - Confidence scores from Stage 4
 * @param {string} version - Normalization pipeline version
 * @param {number} startTime - Pipeline start timestamp
 * @returns {Object} Provenance metadata
 */
function track(filename, structure, contentResult, semantic, confidence, version, startTime) {
  const completedAt = new Date().toISOString();
  const startedAt = new Date(startTime).toISOString();
  const durationMs = Date.now() - startTime;

  // Determine extraction methods used for each artifact
  const extractionMethods = {};

  for (const artifact of contentResult.artifacts) {
    if (artifact.type === 'table') {
      extractionMethods[artifact.id] = 'csv-parser-v2';
    } else if (artifact.type === 'narrative') {
      extractionMethods[artifact.id] = 'markdown-converter-v1';
    }
  }

  // Determine semantic extraction method
  const semanticMethod = semantic.domain && semantic.entities.length > 0
    ? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_FOUNDRY_API_KEY
        ? 'llm-extraction-claude-sonnet-4'
        : 'rule-based-extraction-v1')
    : 'rule-based-extraction-v1';

  extractionMethods['semantic_metadata'] = semanticMethod;

  return {
    source_file: filename,
    uploaded_at: startedAt,
    completed_at: completedAt,
    normalization_version: version,
    extraction_methods: extractionMethods,
    pipeline_duration_ms: durationMs,
    pipeline_stages: {
      stage_0_raw_ingestion: 'completed',
      stage_1_structural_decomposition: 'completed',
      stage_2_content_normalization: 'completed',
      stage_3_semantic_normalization: 'completed',
      stage_4_confidence_scoring: 'completed',
      stage_5_provenance_tracking: 'completed'
    },
    quality_metrics: {
      overall_confidence: confidence.overall,
      artifact_count: contentResult.artifacts.length,
      exclusion_count: confidence.exclusions.length,
      document_type: structure.document_type,
      layout_complexity: structure.layout_complexity
    },
    semantic_summary: {
      domain: semantic.domain,
      entity_count: semantic.entities.length,
      unit_mappings: Object.keys(semantic.units || {}).length,
      time_range_detected: semantic.time_range.start !== null
    }
  };
}

module.exports = {
  track
};
