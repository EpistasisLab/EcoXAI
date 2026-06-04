'use strict';

const wikiService = require('../../services/wikiService');

function attachAdvancedDatasetRoutes(router, { state, saveState, broadcast, volumeManager }) {
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
}

module.exports = attachAdvancedDatasetRoutes;
