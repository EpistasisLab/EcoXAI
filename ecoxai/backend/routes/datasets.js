'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const attachAdvancedDatasetRoutes = require('./datasets/advanced');
const wikiService = require('../services/wikiService');

const PENDING_DIR = path.join(__dirname, '..', 'data', 'pending');

function createDatasetsRoutes(deps) {
  const { state, saveState, broadcast, parseCSV, parseJSON, parseFeather, parseWorkbook, volumeManager, dbManager, normalizationService, upload, orchestrator } = deps;
  const router = express.Router();

  router.post('/upload/dataset', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const filename = req.file.originalname;
      const datasetId = `dataset_${Date.now()}`;

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
      } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        parsedData = parseWorkbook(req.file.buffer);
        fileType = 'xlsx';
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Use CSV, JSON, Feather, or Excel (.xlsx/.xls).' });
      }

      // Store raw file — normalization runs when the user starts the pipeline
      fs.mkdirSync(PENDING_DIR, { recursive: true });
      const pendingFilePath = path.join(PENDING_DIR, `${datasetId}_${filename}`);
      fs.writeFileSync(pendingFilePath, req.file.buffer);

      const columnCount = parsedData.length > 0 ? Object.keys(parsedData[0]).length : 0;
      state.datasets[datasetId] = {
        id: datasetId,
        filename,
        sanitizedFilename: datasetId,
        size: req.file.size,
        uploadedAt: new Date().toISOString(),
        type: fileType,
        recordCount: parsedData.length,
        columnCount,
        status: 'pending',
        _pendingFilePath: pendingFilePath,
      };
      saveState();

      res.json({ success: true, message: 'Dataset uploaded — start the pipeline to begin analysis', datasetId, recordCount: parsedData.length, filename });

      console.log(`✓ Dataset ${datasetId}: ${filename} (${parsedData.length} records) — awaiting pipeline start`);

      broadcast({ type: 'DATASETS_PROMOTED', datasets: Object.values(state.datasets) });

    } catch (error) {
      console.error('Dataset upload error:', error);
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/datasets/:datasetId', (req, res) => {
    const { datasetId } = req.params;
    const { userContext } = req.body || {};
    if (!state.datasets[datasetId]) {
      return res.status(404).json({ success: false, error: 'Dataset not found' });
    }
    if (userContext !== undefined) {
      state.datasets[datasetId].userContext = typeof userContext === 'string' ? userContext : '';
    }
    saveState();
    broadcast({ type: 'DATASETS_PROMOTED', datasets: Object.values(state.datasets) });
    res.json({ success: true });
  });

  attachAdvancedDatasetRoutes(router, { state, saveState, broadcast, volumeManager, dbManager });

  return router;
}

module.exports = createDatasetsRoutes;
