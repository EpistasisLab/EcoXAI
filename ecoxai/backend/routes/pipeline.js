'use strict';

const express = require('express');

function createPipelineRoutes({ orchestrator }) {
  const router = express.Router();

  router.get('/pipeline/status', (req, res) => {
    res.json({ success: true, ...orchestrator.getStatus() });
  });

  router.post('/pipeline/pause', (req, res) => {
    orchestrator.pause();
    res.json({ success: true, message: 'Pipeline paused — auto-advance disabled' });
  });

  router.post('/pipeline/resume', (req, res) => {
    orchestrator.resume();
    res.json({ success: true, message: 'Pipeline resumed — auto-advance enabled' });
  });

  router.post('/pipeline/trigger/:stageId', async (req, res) => {
    const { stageId } = req.params;
    const { datasetId } = req.body || {};
    try {
      await orchestrator.triggerStage(stageId, { datasetId });
      res.json({ success: true, message: `Stage ${stageId} triggered` });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = createPipelineRoutes;
