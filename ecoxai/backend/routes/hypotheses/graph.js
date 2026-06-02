function attachHypothesisGraphRoutes(router, {
  dbManager,
  hypothesisAgent
}) {
  router.get('/hypotheses/:hypothesisId/graph', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId, 10);
      const depth = parseInt(req.query.depth, 10) || 2;
      const graph = await hypothesisAgent.getHypothesisGraph(hypothesisId, depth);

      res.json({
        success: true,
        graph
      });
    } catch (error) {
      console.error('Error getting hypothesis graph:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/hypotheses/:hypothesisId/alternatives', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId, 10);
      const alternatives = await dbManager.getAlternatives(hypothesisId);

      res.json({
        success: true,
        alternatives
      });
    } catch (error) {
      console.error('Error getting alternatives:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/hypotheses/:hypothesisId/dependencies', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId, 10);
      const dependencies = await dbManager.getDependencies(hypothesisId);

      res.json({
        success: true,
        dependencies
      });
    } catch (error) {
      console.error('Error getting dependencies:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.post('/hypotheses/:hypothesisId/mark-alternative', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId, 10);
      const { otherHypothesisId, reasoning } = req.body;

      if (!otherHypothesisId) {
        return res.status(400).json({
          success: false,
          error: 'otherHypothesisId is required'
        });
      }

      await hypothesisAgent.markAsAlternative(
        hypothesisId,
        otherHypothesisId,
        reasoning || 'Manually marked as alternative'
      );

      res.json({
        success: true
      });
    } catch (error) {
      console.error('Error marking as alternative:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/datasets/:datasetId/hypothesis-metrics', async (req, res) => {
    try {
      const { datasetId } = req.params;
      const metrics = await hypothesisAgent.getGraphMetrics(datasetId);

      res.json({
        success: true,
        metrics
      });
    } catch (error) {
      console.error('Error getting graph metrics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.post('/tool-calls/:toolCallId/link-evidence', async (req, res) => {
    try {
      const toolCallId = parseInt(req.params.toolCallId, 10);
      const { links } = req.body;

      if (!links || !Array.isArray(links)) {
        return res.status(400).json({
          success: false,
          error: 'links array is required'
        });
      }

      await hypothesisAgent.linkEvidenceToHypotheses(toolCallId, links);

      res.json({
        success: true
      });
    } catch (error) {
      console.error('Error linking evidence:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

module.exports = attachHypothesisGraphRoutes;
