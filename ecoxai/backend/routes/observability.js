const express = require('express');

function createObservabilityRoutes({ dbManager }) {
  const router = express.Router();

  router.get('/runs', async (req, res) => {
    try {
      const { job_id, status, model, limit, offset } = req.query;

      const runs = await dbManager.listRuns({
        job_id,
        status,
        model,
        limit: limit ? parseInt(limit, 10) : 100,
        offset: offset ? parseInt(offset, 10) : 0
      });

      res.json({
        success: true,
        runs,
        count: runs.length
      });
    } catch (error) {
      console.error('Error listing runs:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/runs/:runId', async (req, res) => {
    try {
      const { runId } = req.params;
      const run = await dbManager.getRunWithStats(runId);

      if (!run) {
        return res.status(404).json({
          success: false,
          error: 'Run not found'
        });
      }

      res.json({
        success: true,
        run
      });
    } catch (error) {
      console.error('Error getting run:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/runs/:runId/steps', async (req, res) => {
    try {
      const { runId } = req.params;
      const { step_type } = req.query;
      const steps = await dbManager.getStepsForRun(runId, step_type);

      res.json({
        success: true,
        steps,
        count: steps.length
      });
    } catch (error) {
      console.error('Error getting steps:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/runs/:runId/tool-calls', async (req, res) => {
    try {
      const { runId } = req.params;
      const { tool_name } = req.query;
      const toolCalls = await dbManager.getToolCallsForRun(runId, tool_name);

      res.json({
        success: true,
        tool_calls: toolCalls,
        count: toolCalls.length
      });
    } catch (error) {
      console.error('Error getting tool calls:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/runs/:runId/stats', async (req, res) => {
    try {
      const { runId } = req.params;
      const toolUsage = await dbManager.getToolUsageStats(runId);

      res.json({
        success: true,
        tool_usage: toolUsage
      });
    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createObservabilityRoutes;
