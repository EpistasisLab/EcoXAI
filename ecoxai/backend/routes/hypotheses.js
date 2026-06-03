/**
 * Hypothesis API Routes
 * Handles all hypothesis-related endpoints including:
 * - Hypothesis extraction from runs/jobs
 * - Hypothesis CRUD operations
 * - Evidence linking
 * - Feature importance reporting
 */

const express = require('express');
const attachHypothesisReportingRoutes = require('./hypotheses/reporting');

/**
 * Creates hypothesis routes with injected dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.state - Shared state object
 * @param {Function} deps.saveState - Function to persist state
 * @param {Function} deps.broadcast - WebSocket broadcast function
 * @param {Object} deps.dbManager - Database manager service
 * @param {Object} deps.volumeManager - Volume manager service
 * @param {Function} deps.stateRepo - Function to get state repository instance
 */
function createHypothesesRoutes({ state, saveState, broadcast, dbManager, volumeManager }) {
  const router = express.Router();

  // GET /api/datasets/:datasetId/hypotheses - Get all hypotheses for a dataset
  router.get('/datasets/:datasetId/hypotheses', async (req, res) => {
    try {
      const { datasetId } = req.params;

      // Check if dataset exists
      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      const hypotheses = await dbManager.getHypothesesForDataset(datasetId);

      // Group by status
      const grouped = {
        proposed: hypotheses.filter(h => h.status === 'proposed'),
        test_requested: hypotheses.filter(h => h.status === 'test_requested'),
        evidence_collected: hypotheses.filter(h => h.status === 'evidence_collected'),
        supported: hypotheses.filter(h => h.status === 'supported'),
        rejected: hypotheses.filter(h => h.status === 'rejected'),
        needs_more_data: hypotheses.filter(h => h.status === 'needs_more_data'),
        revised: hypotheses.filter(h => h.status === 'revised')
      };

      res.json({
        success: true,
        datasetId,
        total: hypotheses.length,
        grouped,
        all: hypotheses
      });
    } catch (error) {
      console.error('Error getting dataset hypotheses:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/datasets/:datasetId/hypotheses/queue - Get priority queue of hypotheses
  router.get('/datasets/:datasetId/hypotheses/queue', async (req, res) => {
    try {
      const { datasetId } = req.params;
      const { status } = req.query; // Optional filter: 'proposed', 'test_requested', etc.

      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      // Get all hypotheses for dataset, ordered by priority
      let sql = `
        SELECT h.*
        FROM hypotheses h
        JOIN agent_runs ar ON h.run_id = ar.run_id
        WHERE ar.dataset_id = ?
      `;

      const params = [datasetId];

      // Add status filter if provided
      if (status) {
        const statuses = status.split(','); // Support multiple statuses: ?status=proposed,test_requested
        sql += ` AND h.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }

      sql += ' ORDER BY h.priority ASC, h.extracted_at DESC';

      const hypotheses = await dbManager._all(sql, params);

      res.json({
        success: true,
        datasetId,
        total: hypotheses.length,
        statusFilter: status || 'all',
        hypotheses
      });
    } catch (error) {
      console.error('Error getting hypothesis queue:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // PATCH /api/hypotheses/:hypothesisId/priority - Update hypothesis priority
  router.patch('/hypotheses/:hypothesisId/priority', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const { priority } = req.body;

      if (typeof priority !== 'number' || priority < 0) {
        return res.status(400).json({
          success: false,
          error: 'Priority must be a non-negative number'
        });
      }

      await dbManager.updateHypothesis(hypothesisId, { priority });

      // Broadcast update via WebSocket
      broadcast({
        type: 'HYPOTHESIS_UPDATE',
        hypothesisId,
        updates: { priority }
      });

      res.json({
        success: true,
        hypothesisId,
        priority
      });
    } catch (error) {
      console.error('Error updating hypothesis priority:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // PATCH /api/hypotheses/reorder - Reorder multiple hypotheses at once
  router.patch('/hypotheses/reorder', async (req, res) => {
    try {
      const { reorders } = req.body; // Array of { hypothesisId, priority }

      if (!Array.isArray(reorders)) {
        return res.status(400).json({
          success: false,
          error: 'reorders must be an array of { hypothesisId, priority }'
        });
      }

      // Update all priorities in a transaction-like manner
      for (const { hypothesisId, priority } of reorders) {
        await dbManager.updateHypothesis(hypothesisId, { priority });
      }

      // Broadcast batch update
      broadcast({
        type: 'HYPOTHESIS_QUEUE_REORDER',
        reorders
      });

      res.json({
        success: true,
        updated: reorders.length
      });
    } catch (error) {
      console.error('Error reordering hypotheses:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/datasets/:datasetId/hypothesis-config - Get hypothesis generation config
  router.get('/datasets/:datasetId/hypothesis-config', async (req, res) => {
    try {
      const { datasetId } = req.params;

      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      // Return config or default
      const config = state.datasets[datasetId].hypothesisConfig || {
        featureImportance: 100,
        featureEngineering: 0,
        version: '1.0.0'
      };

      res.json({
        success: true,
        config
      });
    } catch (error) {
      console.error('Error getting hypothesis config:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // PUT /api/datasets/:datasetId/hypothesis-config - Update hypothesis generation config
  router.put('/datasets/:datasetId/hypothesis-config', async (req, res) => {
    try {
      const { datasetId } = req.params;
      const { featureImportance, featureEngineering } = req.body;

      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      // Validate percentages
      if (typeof featureImportance !== 'number' || typeof featureEngineering !== 'number') {
        return res.status(400).json({
          success: false,
          error: 'featureImportance and featureEngineering must be numbers'
        });
      }

      if (featureImportance < 0 || featureImportance > 100 || featureEngineering < 0 || featureEngineering > 100) {
        return res.status(400).json({
          success: false,
          error: 'Percentages must be between 0 and 100'
        });
      }

      const total = featureImportance + featureEngineering;
      if (total !== 100) {
        return res.status(400).json({
          success: false,
          error: `Hypothesis config percentages must sum to 100 (got ${total})`
        });
      }

      // Update config
      state.datasets[datasetId].hypothesisConfig = {
        featureImportance,
        featureEngineering,
        version: '1.0.0'
      };

      saveState();

      res.json({
        success: true,
        config: state.datasets[datasetId].hypothesisConfig
      });
    } catch (error) {
      console.error('Error updating hypothesis config:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  attachHypothesisReportingRoutes(router, {
    state,
    dbManager,
    volumeManager
  });

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

  // GET /api/hypotheses/:hypothesisId - Get hypothesis with evidence
  router.get('/hypotheses/:hypothesisId', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);

      const hypothesis = await dbManager.getHypothesisWithEvidence(hypothesisId);

      if (!hypothesis) {
        return res.status(404).json({
          success: false,
          error: `Hypothesis ${hypothesisId} not found`
        });
      }

      res.json({
        success: true,
        hypothesis
      });
    } catch (error) {
      console.error('Error getting hypothesis:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // PATCH /api/hypotheses/:hypothesisId/status - Update hypothesis status
  router.patch('/hypotheses/:hypothesisId/status', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required'
        });
      }

      await dbManager.updateHypothesis(hypothesisId, { status });

      // Broadcast hypothesis update
      broadcast({
        type: 'HYPOTHESIS_UPDATE',
        hypothesis_id: hypothesisId,
        status: status
      });

      res.json({
        success: true,
        hypothesis_id: hypothesisId,
        status: status
      });
    } catch (error) {
      console.error('Error updating hypothesis status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/hypotheses/pending - Get hypotheses needing attention
  router.get('/hypotheses/pending', async (req, res) => {
    try {
      const needingEvidence = await dbManager.getHypothesesNeedingEvidence();
      const needingEvaluation = await dbManager.getUnevaluatedHypotheses();

      res.json({
        success: true,
        needing_evidence: needingEvidence,
        needing_evaluation: needingEvaluation
      });
    } catch (error) {
      console.error('Error getting pending hypotheses:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // POST /api/hypotheses/:hypothesisId/link-evidence - Manually link evidence
  router.post('/hypotheses/:hypothesisId/link-evidence', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const { toolCallId, supports, confidence, evidenceText } = req.body;

      if (toolCallId === undefined || supports === undefined) {
        return res.status(400).json({
          success: false,
          error: 'toolCallId and supports are required'
        });
      }

      const evidenceId = await dbManager.linkToolCallToHypothesis(
        toolCallId,
        hypothesisId,
        supports,
        confidence || 0.7
      );

      res.json({
        success: true,
        evidence_id: evidenceId
      });
    } catch (error) {
      console.error('Error linking evidence:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/runs/:runId/hypotheses - Get all hypotheses for a run
  router.get('/runs/:runId/hypotheses', async (req, res) => {
    try {
      const { runId } = req.params;

      const hypotheses = await dbManager.getHypothesesForRun(runId);

      res.json({
        success: true,
        run_id: runId,
        count: hypotheses.length,
        hypotheses
      });
    } catch (error) {
      console.error('Error getting hypotheses for run:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
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

      broadcast({
        type: 'HYPOTHESIS_DELETED',
        hypothesisId
      });

      res.json({ success: true, hypothesisId });
    } catch (error) {
      console.error('Error deleting hypothesis:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = createHypothesesRoutes;
