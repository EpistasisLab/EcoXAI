'use strict';

const express = require('express');

function createHypothesesRoutes({ state, saveState, broadcast, dbManager }) {
  const router = express.Router();

  // GET /api/hypotheses - List all hypotheses (used by frontend)
  router.get('/hypotheses', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 200, 500);
      const status = req.query.status || null;
      const hypotheses = await dbManager.listHypotheses({ limit, status });
      res.json({ success: true, hypotheses });
    } catch (error) {
      console.error('Error listing hypotheses:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/hypotheses - Batch create hypotheses (called by pipeline-hypothesize agent)
  router.post('/hypotheses', async (req, res) => {
    try {
      const { job_id, hypotheses } = req.body;
      if (!job_id || !Array.isArray(hypotheses) || hypotheses.length === 0) {
        return res.status(400).json({ success: false, error: 'job_id and a non-empty hypotheses array are required' });
      }

      const run = dbManager.getRunByJobId(job_id);
      if (!run) {
        return res.status(404).json({ success: false, error: `No run found for job_id ${job_id}` });
      }

      const created = [];
      for (const h of hypotheses) {
        if (!h.hypothesis_text) continue;
        const confidence = typeof h.confidence_score === 'number' ? Math.max(0, Math.min(1, h.confidence_score)) : null;
        const priority = confidence !== null ? Math.floor(1000 - (confidence * 900)) : 1000;
        const hypothesisId = await dbManager.createHypothesis({
          run_id: run.run_id,
          turn_number: h.turn_number || 1,
          hypothesis_text: h.hypothesis_text,
          hypothesis_type: h.hypothesis_type || null,
          confidence_score: confidence,
          status: 'proposed',
          expected_metric: h.expected_metric || null,
          feature_name: h.feature_name || null,
          evaluation_reasoning: h.novelty_rationale || null,
          priority,
        });
        created.push({ hypothesis_id: hypothesisId, hypothesis_text: h.hypothesis_text, hypothesis_type: h.hypothesis_type });
      }

      broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses', jobId: job_id });
      res.json({ success: true, created });
    } catch (error) {
      console.error('Error creating hypotheses:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/hypotheses/:hypothesisId - Get hypothesis with evidence
  router.get('/hypotheses/:hypothesisId', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const hypothesis = await dbManager.getHypothesisWithEvidence(hypothesisId);
      if (!hypothesis) {
        return res.status(404).json({ success: false, error: `Hypothesis ${hypothesisId} not found` });
      }
      res.json({ success: true, hypothesis });
    } catch (error) {
      console.error('Error getting hypothesis:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // PATCH /api/hypotheses/:hypothesisId/status - Update hypothesis status
  router.patch('/hypotheses/:hypothesisId/status', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const { status } = req.body;
      if (!status) {
        return res.status(400).json({ success: false, error: 'Status is required' });
      }
      await dbManager.updateHypothesis(hypothesisId, { status });
      broadcast({ type: 'HYPOTHESIS_UPDATE', hypothesis_id: hypothesisId, status });
      res.json({ success: true, hypothesis_id: hypothesisId, status });
    } catch (error) {
      console.error('Error updating hypothesis status:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/datasets/:datasetId/hypotheses/reset - Reset all hypotheses to proposed
  router.post('/datasets/:datasetId/hypotheses/reset', async (req, res) => {
    try {
      const { datasetId } = req.params;
      if (!state.datasets[datasetId]) {
        return res.status(404).json({ success: false, error: `Dataset ${datasetId} not found` });
      }
      const hypotheses = await dbManager.getHypothesesForDataset(datasetId);
      let count = 0;
      for (const h of hypotheses) {
        if (h.status !== 'proposed') {
          await dbManager.updateHypothesis(h.hypothesis_id, { status: 'proposed' });
          count++;
        }
      }
      broadcast({ type: 'HYPOTHESIS_UPDATE', datasetId, reset: true });
      res.json({ success: true, datasetId, resetCount: count, totalHypotheses: hypotheses.length });
    } catch (error) {
      console.error('Error resetting hypotheses:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // DELETE /api/hypotheses/:hypothesisId - Delete a hypothesis
  router.delete('/hypotheses/:hypothesisId', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      await dbManager.deleteHypothesis(hypothesisId);
      broadcast({ type: 'HYPOTHESIS_DELETED', hypothesisId });
      res.json({ success: true, hypothesisId });
    } catch (error) {
      console.error('Error deleting hypothesis:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = createHypothesesRoutes;
