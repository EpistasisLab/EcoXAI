/**
 * Normalization Service
 *
 * Multi-stage pipeline for converting raw datasets into normalized, confidence-scored,
 * semantically-annotated data that agents can trust.
 *
 * Pipeline stages:
 * 0. Raw Ingestion - Immutable archival
 * 1. Structural Decomposition - Classify document types
 * 2. Content Normalization - Canonicalize formats
 * 3. Semantic Normalization - Extract domain metadata
 * 4. Confidence Scoring - Quality gates
 * 5. Provenance Tracking - Lineage metadata
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const structuralAnalyzer = require('../lib/structuralAnalyzer');
const contentCanonicalizer = require('../lib/contentCanonicalizer');
const semanticExtractor = require('../lib/semanticExtractor');
const confidenceScorer = require('../lib/confidenceScorer');
const provenanceTracker = require('../lib/provenanceTracker');

const NORMALIZATION_VERSION = '1.0.0';
const CONFIDENCE_THRESHOLD = 0.9;

class NormalizationService {
  constructor() {
    this.tmpDir = path.join(os.tmpdir(), 'ecoxai-normalization');
  }

  /**
   * Initialize normalization service (create temp directories)
   */
  async initialize() {
    try {
      await fs.mkdir(this.tmpDir, { recursive: true });
    } catch (err) {
      console.warn('Failed to create normalization temp directory:', err.message);
    }
  }

  /**
   * Main normalization pipeline orchestrator
   *
   * @param {string} datasetId - Dataset identifier
   * @param {string} filename - Original filename
   * @param {Buffer} buffer - Raw file contents
   * @returns {Promise<Object>} Normalization result
   */
  async normalizeDataset(datasetId, filename, buffer) {
    const startTime = Date.now();

    try {
      // Create temporary working directory for this dataset
      const workDir = path.join(this.tmpDir, datasetId);
      await fs.mkdir(workDir, { recursive: true });

      // Create output directory structure
      const rawDir = path.join(workDir, 'raw');
      const normalizedDir = path.join(workDir, 'normalized');
      const docsDir = path.join(normalizedDir, 'docs');
      const tablesDir = path.join(normalizedDir, 'tables');

      await fs.mkdir(rawDir, { recursive: true });
      await fs.mkdir(normalizedDir, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });
      await fs.mkdir(tablesDir, { recursive: true });

      console.log(`[Normalization] Starting pipeline for ${datasetId} (${filename})`);

      // Stage 0: Raw Ingestion
      const rawResult = await this.stageRawIngestion(
        datasetId,
        filename,
        buffer,
        rawDir
      );

      // Stage 1: Structural Decomposition
      const structureResult = await this.stageStructuralDecomposition(
        datasetId,
        rawResult.rawPath,
        filename
      );

      // Stage 2: Content Normalization
      const contentResult = await this.stageContentNormalization(
        datasetId,
        rawResult.rawPath,
        filename,
        structureResult,
        docsDir,
        tablesDir
      );

      // Stage 3: Semantic Normalization
      const semanticResult = await this.stageSemanticNormalization(
        datasetId,
        structureResult,
        contentResult
      );

      // Stage 4: Confidence Scoring
      const confidenceResult = await this.stageConfidenceScoring(
        datasetId,
        structureResult,
        contentResult,
        semanticResult
      );

      // Stage 5: Provenance Tracking
      const provenanceResult = await this.stageProvenanceTracking(
        datasetId,
        filename,
        structureResult,
        contentResult,
        semanticResult,
        confidenceResult,
        startTime
      );

      // Write metadata JSON files to normalized directory
      await fs.writeFile(
        path.join(normalizedDir, 'structure.json'),
        JSON.stringify(structureResult, null, 2)
      );

      await fs.writeFile(
        path.join(normalizedDir, 'semantic.json'),
        JSON.stringify(semanticResult, null, 2)
      );

      await fs.writeFile(
        path.join(normalizedDir, 'confidence.json'),
        JSON.stringify(confidenceResult, null, 2)
      );

      await fs.writeFile(
        path.join(normalizedDir, 'provenance.json'),
        JSON.stringify(provenanceResult, null, 2)
      );

      const duration = Date.now() - startTime;

      console.log(`[Normalization] Completed in ${duration}ms for ${datasetId}`);
      console.log(`[Normalization] Overall confidence: ${confidenceResult.overall.toFixed(2)}`);
      console.log(`[Normalization] Document type: ${structureResult.document_type}`);
      console.log(`[Normalization] Artifacts: ${contentResult.artifacts.length}`);
      console.log(`[Normalization] Exclusions: ${confidenceResult.exclusions.length}`);

      return {
        success: true,
        version: NORMALIZATION_VERSION,
        datasetId,
        normalizedPath: workDir,
        overallConfidence: confidenceResult.overall,
        documentType: structureResult.document_type,
        artifacts: contentResult.artifacts,
        excluded: confidenceResult.exclusions,
        semanticMetadata: semanticResult,
        durationMs: duration,
        summary: {
          version: NORMALIZATION_VERSION,
          confidence: confidenceResult.overall,
          documentType: structureResult.document_type,
          artifactCount: contentResult.artifacts.length,
          exclusionCount: confidenceResult.exclusions.length,
          durationMs: duration
        }
      };

    } catch (error) {
      console.error('[Normalization] Pipeline failed:', error);

      return {
        success: false,
        error: error.message,
        stack: error.stack
      };
    }
  }

  /**
   * Stage 0: Raw Ingestion
   * Save immutable copy of original file
   */
  async stageRawIngestion(datasetId, filename, buffer, rawDir) {
    const rawPath = path.join(rawDir, filename);
    await fs.writeFile(rawPath, buffer);

    // Compute content hash for deduplication
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Create metadata
    const metadata = {
      filename,
      size: buffer.length,
      contentHash: hash,
      archivedAt: new Date().toISOString()
    };

    await fs.writeFile(
      path.join(rawDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    console.log(`[Stage 0] Raw ingestion complete: ${filename} (${buffer.length} bytes)`);

    return {
      rawPath,
      contentHash: hash,
      metadata
    };
  }

  /**
   * Stage 1: Structural Decomposition
   * Classify document type and identify sections
   */
  async stageStructuralDecomposition(datasetId, rawPath, filename) {
    console.log(`[Stage 1] Analyzing structure of ${filename}`);

    const structure = await structuralAnalyzer.analyze(rawPath, filename);

    console.log(`[Stage 1] Document type: ${structure.document_type}`);
    console.log(`[Stage 1] Sections: ${structure.sections.length}`);

    return structure;
  }

  /**
   * Stage 2: Content Normalization
   * Convert content to canonical formats (CSV, markdown, JSON)
   */
  async stageContentNormalization(datasetId, rawPath, filename, structure, docsDir, tablesDir) {
    console.log(`[Stage 2] Normalizing content for ${filename}`);

    const contentResult = await contentCanonicalizer.canonicalize(
      rawPath,
      filename,
      structure,
      docsDir,
      tablesDir
    );

    console.log(`[Stage 2] Generated ${contentResult.artifacts.length} artifacts`);

    return contentResult;
  }

  /**
   * Stage 3: Semantic Normalization
   * Extract domain metadata (entities, time ranges, units)
   */
  async stageSemanticNormalization(datasetId, structure, contentResult) {
    console.log(`[Stage 3] Extracting semantic metadata for ${datasetId}`);

    const semantic = await semanticExtractor.extract(structure, contentResult);

    console.log(`[Stage 3] Domain: ${semantic.domain || 'unknown'}`);
    console.log(`[Stage 3] Entities: ${semantic.entities.length}`);

    return semantic;
  }

  /**
   * Stage 4: Confidence Scoring
   * Score extraction quality and apply thresholds
   */
  async stageConfidenceScoring(datasetId, structure, contentResult, semantic) {
    console.log(`[Stage 4] Scoring confidence for ${datasetId}`);

    const confidence = await confidenceScorer.score(
      structure,
      contentResult,
      semantic,
      CONFIDENCE_THRESHOLD
    );

    console.log(`[Stage 4] Overall confidence: ${confidence.overall.toFixed(2)}`);
    console.log(`[Stage 4] Exclusions: ${confidence.exclusions.length}`);

    return confidence;
  }

  /**
   * Stage 5: Provenance Tracking
   * Record lineage metadata
   */
  async stageProvenanceTracking(datasetId, filename, structure, contentResult, semantic, confidence, startTime) {
    console.log(`[Stage 5] Recording provenance for ${datasetId}`);

    const provenance = provenanceTracker.track(
      filename,
      structure,
      contentResult,
      semantic,
      confidence,
      NORMALIZATION_VERSION,
      startTime
    );

    console.log(`[Stage 5] Provenance recorded`);

    return provenance;
  }

  /**
   * Get normalization status for a dataset
   *
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<Object|null>} Normalization status or null if not normalized
   */
  async getNormalizationStatus(datasetId) {
    const workDir = path.join(this.tmpDir, datasetId);
    const normalizedDir = path.join(workDir, 'normalized');

    try {
      const [structure, semantic, confidence, provenance] = await Promise.all([
        fs.readFile(path.join(normalizedDir, 'structure.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(normalizedDir, 'semantic.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(normalizedDir, 'confidence.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(normalizedDir, 'provenance.json'), 'utf8').then(JSON.parse)
      ]);

      return {
        exists: true,
        structure,
        semantic,
        confidence,
        provenance
      };
    } catch (err) {
      return null;
    }
  }
}

// Export singleton instance
module.exports = new NormalizationService();
