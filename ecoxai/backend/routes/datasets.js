'use strict';

const express = require('express');
const path = require('path');
const attachAdvancedDatasetRoutes = require('./datasets/advanced');
const wikiService = require('../services/wikiService');

function createDatasetsRoutes(deps) {
  const { state, saveState, broadcast, parseCSV, parseJSON, parseFeather, volumeManager, dbManager, normalizationService, upload, orchestrator } = deps;
  const router = express.Router();

  router.post('/upload/dataset', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const filename = req.file.originalname;
      const datasetId = `dataset_${Date.now()}`;

      let customContext = null;
      if (req.body.customContext) {
        try { customContext = JSON.parse(req.body.customContext); }
        catch (error) { return res.status(400).json({ error: 'Invalid customContext JSON: ' + error.message }); }
      }

      let parsedData;
      let fileType;
      if (filename.endsWith('.csv')) {
        parsedData = parseCSV(req.file.buffer.toString('utf-8'));
        fileType = 'csv';
      } else if (filename.endsWith('.json')) {
        parsedData = parseJSON(req.file.buffer.toString('utf-8'));
        fileType = 'json';
      } else if (filename.endsWith('.feather')) {
        parsedData = await parseFeather(req.file.buffer);
        fileType = 'feather';
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Use CSV, JSON, or Feather.' });
      }

      console.log(`[Upload] Normalizing ${datasetId}...`);
      const normalizationResult = await normalizationService.normalizeDataset(datasetId, filename, req.file.buffer);
      if (!normalizationResult.success) {
        return res.status(500).json({ error: 'Normalization failed', details: normalizationResult.error });
      }

      // Merge custom context if provided
      let mergedSemanticMetadata = normalizationResult.semanticMetadata;
      if (customContext) {
        try {
          const contextMerger = require('../services/contextMerger');
          const fs = require('fs').promises;
          const normalizedPath = normalizationResult.normalizedPath;
          const contextFiles = ['structure.json', 'semantic.json', 'confidence.json', 'provenance.json'];
          const autoContext = {};
          for (const cf of contextFiles) {
            try {
              const content = await fs.readFile(path.join(normalizedPath, 'normalized', cf), 'utf-8');
              autoContext[cf.replace('.json', '')] = JSON.parse(content);
            } catch (_) {}
          }
          const mergedContext = contextMerger.mergeCustomContext(autoContext, customContext, 'supplement');
          for (const [key, value] of Object.entries(mergedContext)) {
            await fs.writeFile(path.join(normalizedPath, 'normalized', `${key}.json`), JSON.stringify(value, null, 2), 'utf-8');
          }
          if (mergedContext.semantic) mergedSemanticMetadata = mergedContext.semantic;
        } catch (error) {
          return res.status(500).json({ error: 'Failed to merge custom context', details: error.message });
        }
      }

      // Copy normalized data to Docker datasets volume
      const copyResult = await volumeManager.copyNormalizedDatasetToVolume(datasetId, normalizationResult.normalizedPath);
      if (!copyResult.success) {
        return res.status(500).json({ error: 'Failed to copy dataset to volume: ' + copyResult.error });
      }

      const columnCount = parsedData.length > 0 ? Object.keys(parsedData[0]).length : 0;
      const datasetMetadata = {
        id: datasetId,
        filename,
        sanitizedFilename: datasetId,
        size: req.file.size,
        uploadedAt: new Date().toISOString(),
        type: fileType,
        recordCount: parsedData.length,
        columnCount,
        normalization: {
          version: normalizationResult.version,
          confidence: normalizationResult.overallConfidence,
          documentType: normalizationResult.documentType,
          artifacts: normalizationResult.artifacts,
          excluded: normalizationResult.excluded,
          semanticMetadata: mergedSemanticMetadata,
          customContextApplied: customContext !== null,
          normalizedPath: normalizationResult.normalizedPath
        }
      };

      if (dbManager) {
        try {
          await dbManager.trackNormalization({
            dataset_id: datasetId,
            version: normalizationResult.version,
            started_at: new Date(Date.now() - normalizationResult.durationMs).toISOString(),
            completed_at: new Date().toISOString(),
            duration_ms: normalizationResult.durationMs,
            success: 1,
            overall_confidence: normalizationResult.overallConfidence,
            document_type: normalizationResult.documentType,
            num_artifacts: normalizationResult.artifacts.length,
            num_exclusions: normalizationResult.excluded.length,
            metadata_json: JSON.stringify(normalizationResult.semanticMetadata)
          });
        } catch (dbErr) {
          console.warn('[Upload] DB tracking failed:', dbErr.message);
        }
      }

      state.datasets[datasetId] = datasetMetadata;
      saveState();

      res.json({
        success: true,
        message: 'Dataset uploaded and normalized',
        datasetId,
        recordCount: parsedData.length,
        filename,
        normalization: normalizationResult.summary
      });

      console.log(`✓ Dataset ${datasetId}: ${filename} (${parsedData.length} records, confidence=${normalizationResult.overallConfidence.toFixed(2)})`);

      broadcast({ type: 'DATASETS_PROMOTED', datasets: Object.values(state.datasets) });

      // Fire orchestrator event
      if (orchestrator) {
        // EventEmitter.emit() is synchronous and returns a boolean, not a Promise.
        // Async listener errors surface via the global unhandledRejection handler,
        // matching the job_completed / hypotheses_extracted call sites.
        orchestrator.emit('dataset_uploaded', {
          datasetId,
          filename,
          recordCount: parsedData.length,
          domain: mergedSemanticMetadata?.domain || 'unknown'
        });
      }

      // Async wiki portrait
      volumeManager.readDatasetContext(datasetId).then(ctx =>
        wikiService.compilePortrait(datasetId, state.datasets[datasetId], ctx)
      ).then(() => broadcast({ type: 'WIKI_UPDATE', datasetId }))
        .catch(err => console.warn(`[Wiki] Portrait failed:`, err.message));

    } catch (error) {
      console.error('Dataset upload error:', error);
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/datasets', (req, res) => {
    const datasets = Object.values(state.datasets).map(ds => ({
      id: ds.id, filename: ds.filename, size: ds.size,
      uploadedAt: ds.uploadedAt, type: ds.type,
      recordCount: ds.recordCount, columnCount: ds.columnCount,
      normalization: ds.normalization ? {
        confidence: ds.normalization.confidence,
        documentType: ds.normalization.documentType,
        domain: ds.normalization.semanticMetadata?.domain
      } : null
    }));
    res.json({ datasets });
  });

  attachAdvancedDatasetRoutes(router, { state, saveState, broadcast, volumeManager, dbManager });

  return router;
}

module.exports = createDatasetsRoutes;
