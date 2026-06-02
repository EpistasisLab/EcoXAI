'use strict';

const wikiService = require('../../services/wikiService');

function attachAdvancedDatasetRoutes(router, { state, saveState, broadcast, volumeManager, dbManager }) {
  router.get('/datasets/:id', (req, res) => {
    const dataset = state.datasets[req.params.id];
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    res.json(dataset);
  });

  router.get('/datasets/:id/context', async (req, res) => {
    const datasetId = req.params.id;
    if (!state.datasets[datasetId]) return res.status(404).json({ error: 'Dataset not found' });
    try {
      const context = await volumeManager.readDatasetContext(datasetId);
      res.json({ success: true, datasetId, context });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to read dataset context', details: error.message });
    }
  });

  router.get('/datasets/:id/normalization', async (req, res) => {
    const datasetId = req.params.id;
    if (!state.datasets[datasetId]) return res.status(404).json({ error: 'Dataset not found' });
    try {
      const report = await dbManager.getNormalizationReport(datasetId);
      if (!report) return res.status(404).json({ error: 'Normalization data not found' });
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve normalization report: ' + error.message });
    }
  });

  router.delete('/datasets/:id', async (req, res) => {
    const datasetId = req.params.id;
    const dataset = state.datasets[datasetId];
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    try {
      await volumeManager.removeDatasetFromVolume(datasetId, dataset.filename);
    } catch (err) {
      console.warn(`[Delete] Volume cleanup failed for ${datasetId}:`, err.message);
    }
    delete state.datasets[datasetId];
    saveState();
    res.json({ success: true, message: 'Dataset deleted successfully', datasetId });
    console.log(`✓ Deleted dataset ${datasetId}: ${dataset.filename}`);
  });

  router.get('/datasets/:id/wiki', async (req, res) => {
    const datasetId = req.params.id;
    const dataset = state.datasets[datasetId];
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    const wiki = await wikiService.getWiki(datasetId);
    res.json({ success: true, datasetId, wiki, compiling: !wiki.portrait });
    if (!wiki.portrait) {
      volumeManager.readDatasetContext(datasetId)
        .then(ctx => wikiService.compilePortrait(datasetId, dataset, ctx))
        .then(() => broadcast({ type: 'WIKI_UPDATE', datasetId }))
        .catch(err => console.warn(`[Wiki] Auto-compile failed for ${datasetId}:`, err.message));
    }
  });

  router.post('/datasets/:id/wiki/compile', async (req, res) => {
    const datasetId = req.params.id;
    const dataset = state.datasets[datasetId];
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    res.json({ success: true, message: 'Portrait compilation started' });
    try {
      const context = await volumeManager.readDatasetContext(datasetId);
      await wikiService.compilePortrait(datasetId, dataset, context);
      broadcast({ type: 'WIKI_UPDATE', datasetId });
    } catch (err) {
      console.warn(`[Wiki] Recompile failed for ${datasetId}:`, err.message);
    }
  });

  router.post('/datasets/:id/wiki/query', async (req, res) => {
    const datasetId = req.params.id;
    const dataset = state.datasets[datasetId];
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    try {
      const answer = await wikiService.answerAndFileQA(datasetId, question, dataset);
      broadcast({ type: 'WIKI_UPDATE', datasetId });
      res.json({ success: true, question, answer });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = attachAdvancedDatasetRoutes;
