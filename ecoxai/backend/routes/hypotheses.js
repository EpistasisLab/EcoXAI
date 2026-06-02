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
 * @param {Object} deps.hypothesisAgent - Hypothesis agent service
 * @param {Object} deps.volumeManager - Volume manager service
 * @param {Function} deps.stateRepo - Function to get state repository instance
 */
function createHypothesesRoutes({ state, saveState, broadcast, dbManager, hypothesisAgent, volumeManager, stateRepo }) {
  const router = express.Router();

  // POST /api/runs/:runId/hypotheses/extract - Extract hypotheses from run
  router.post('/runs/:runId/hypotheses/extract', async (req, res) => {
    try {
      const { runId } = req.params;

      // Get run details to find dataset domain and hypothesis config
      const run = await dbManager.getRun(runId);
      let datasetDomain = null;
      let hypothesisConfig = null;

      if (run?.dataset_id) {
        const dataset = state.datasets[run.dataset_id];
        if (dataset?.normalization?.semanticMetadata?.domain) {
          datasetDomain = dataset.normalization.semanticMetadata.domain;
          console.log(`Dataset domain: ${datasetDomain}`);
        }
        if (dataset?.hypothesisConfig) {
          hypothesisConfig = dataset.hypothesisConfig;
          console.log(`Hypothesis config: ${hypothesisConfig.featureImportance}% FI, ${hypothesisConfig.featureEngineering}% FE`);
        }
      }

      const hypotheses = await hypothesisAgent.extractHypotheses(runId, { datasetDomain, hypothesisConfig });

      res.json({
        success: true,
        count: hypotheses.length,
        hypotheses
      });
    } catch (error) {
      console.error('Error extracting hypotheses:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // POST /api/jobs/:jobId/hypotheses/extract - Extract hypotheses from job's most recent run
  router.post('/jobs/:jobId/hypotheses/extract', async (req, res) => {
    try {
      const { jobId } = req.params;

      // Find the most recent completed run for this job
      const runs = await dbManager.listRuns({ job_id: jobId, status: 'completed', limit: 1 });

      if (!runs || runs.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No completed runs found for this job'
        });
      }

      const mostRecentRun = runs[0];
      console.log(`Extracting hypotheses from job ${jobId}, run ${mostRecentRun.run_id}`);

      // Find the job to get datasetId
      const job = state.jobs.find(j => j.id === jobId);

      // Get dataset domain and hypothesis config if available
      let datasetDomain = null;
      let hypothesisConfig = null;
      if (job?.datasetId) {
        const dataset = state.datasets[job.datasetId];
        if (dataset?.normalization?.semanticMetadata?.domain) {
          datasetDomain = dataset.normalization.semanticMetadata.domain;
          console.log(`Dataset domain: ${datasetDomain}`);
        }
        if (dataset?.hypothesisConfig) {
          hypothesisConfig = dataset.hypothesisConfig;
          console.log(`Hypothesis config: ${hypothesisConfig.featureImportance}% FI, ${hypothesisConfig.featureEngineering}% FE`);
        }
      }

      const hypotheses = await hypothesisAgent.extractHypotheses(mostRecentRun.run_id, { datasetDomain, hypothesisConfig });

      // Broadcast hypothesis extraction event
      broadcast({
        type: 'HYPOTHESES_EXTRACTED',
        jobId: jobId,
        runId: mostRecentRun.run_id,
        datasetId: job?.datasetId || null,
        count: hypotheses.length,
        hypotheses
      });

      res.json({
        success: true,
        jobId: jobId,
        runId: mostRecentRun.run_id,
        count: hypotheses.length,
        hypotheses
      });
    } catch (error) {
      console.error('Error extracting hypotheses from job:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

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

  // POST /api/datasets/:datasetId/hypotheses/next - Generate next hypothesis based on context and history
  router.post('/datasets/:datasetId/hypotheses/next', async (req, res) => {
    try {
      const { datasetId } = req.params;

      // Check if dataset exists
      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      // Get hypothesis config (use default if not set)
      const hypothesisConfig = state.datasets[datasetId].hypothesisConfig || {
        featureImportance: 100,
        featureEngineering: 0
      };

      const result = await hypothesisAgent.generateNextHypothesis(datasetId, state, hypothesisConfig);

      if (!result.success) {
        return res.status(500).json(result);
      }

      res.json(result);
    } catch (error) {
      console.error('Error generating next hypothesis:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // POST /api/datasets/:datasetId/generate-hypothesis-job - Create hypothesis generation job
  router.post('/datasets/:datasetId/generate-hypothesis-job', async (req, res) => {
    try {
      const { datasetId } = req.params;

      // Check if dataset exists
      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      // Get dataset context
      const dataset = state.datasets[datasetId];
      const domain = dataset.normalization?.semanticMetadata?.domain || 'unknown';
      const entities = dataset.normalization?.semanticMetadata?.entities || [];
      const confidence = dataset.normalization?.confidence || 'N/A';

      // Get hypothesis config (use default if not set)
      const hypothesisConfig = state.datasets[datasetId].hypothesisConfig || {
        featureImportance: 100,
        featureEngineering: 0
      };

      // Generate next hypothesis to get recommended skills and prompt
      const result = await hypothesisAgent.generateNextHypothesis(datasetId, state, hypothesisConfig);

      if (!result.success) {
        return res.status(500).json(result);
      }

      // Create a run record for this generation (needed for hypothesis insertion)
      const generationRunId = `gen_${Date.now()}`;
      await dbManager.createRun({
        run_id: generationRunId,
        job_id: 'hypothesis_generation',
        prompt: 'Generate next hypothesis',
        dataset_id: datasetId,
        started_at: new Date().toISOString(),
        status: 'completed',
        completed_at: new Date().toISOString()
      });

      // Calculate priority from confidence
      const priority = result.hypothesis.confidence_score
        ? Math.floor(1000 - (result.hypothesis.confidence_score * 900))
        : 1000;

      // Insert hypothesis into database BEFORE creating job
      const hypothesisId = await dbManager.createHypothesis({
        run_id: generationRunId,
        turn_number: 1,
        hypothesis_text: result.hypothesis.hypothesis_text,
        hypothesis_type: result.hypothesis.hypothesis_type,
        confidence_score: result.hypothesis.confidence_score,
        status: 'proposed',
        expected_importance: result.hypothesis.expected_importance || null,
        expected_metric: result.hypothesis.expected_metric || null,
        alzkb_source: result.hypothesis.alzkb_source || null,
        feature_name: result.hypothesis.feature_name || null,
        priority: priority
      });

      console.log(`Created hypothesis H${hypothesisId} for testing`);

      // Build prompt for hypothesis testing job
      const isGenomic = domain === 'genomics';
      const prompt = `Test the following hypothesis:

Hypothesis: ${result.hypothesis.hypothesis_text}
Type: ${result.hypothesis.hypothesis_type}
Expected Importance: ${result.hypothesis.expected_importance || 'N/A'}
Expected Metric: ${result.hypothesis.expected_metric || 'N/A'}
${result.hypothesis.alzkb_source ? `AlzKB Source: ${result.hypothesis.alzkb_source}` : ''}

Dataset: ${dataset.filename} (${domain})
Available Features: ${entities.join(', ')}

Your task: Design and execute an analysis to test this hypothesis. Generate results in the appropriate format (feature_importance_results.json or feature_engineering_results.json).`;

      // Use recommended skills from hypothesis generation
      const selectedSkills = result.recommendedSkills || [];

      // Create hypothesis testing job
      const newJob = {
        id: `H${Date.now()}`,  // H prefix for hypothesis jobs
        title: `Test H${hypothesisId}: ${result.hypothesis.hypothesis_text.substring(0, 50)}${result.hypothesis.hypothesis_text.length > 50 ? '...' : ''}`,
        jobType: 'hypothesis_testing',
        priority: 'High',
        status: 'todo',
        assignee: null,
        prompt,
        datasetId,
        selectedSkills,
        skillsInvoked: [],
        output: '',
        artifacts: [],
        exitCode: null,
        startedAt: null,
        completedAt: null,
        containerId: null,
        createdBy: 'hypothesis_agent',
        createdAt: new Date().toISOString(),
        testingHypothesisId: hypothesisId,  // Link job to hypothesis!
      };

      // Write to database (Phase 1: primary source of truth)
      const repo = stateRepo();
      if (repo) {
        try {
          await repo.createJob(newJob);
        } catch (dbError) {
          console.error('Failed to write job to database:', dbError);
        }
      }

      // Add to state (Phase 1: backward compatibility)
      state.jobs.push(newJob);
      saveState();

      broadcast({
        type: 'JOB_UPDATE',
        jobs: state.jobs,
      });

      res.json({
        success: true,
        job: newJob,
      });

      console.log(`✓ Created hypothesis generation job ${newJob.id} for dataset ${datasetId}`);
    } catch (error) {
      console.error('Error creating hypothesis generation job:', error);
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

  // POST /api/hypotheses/:hypothesisId/request-evidence - Generate evidence request
  router.post('/hypotheses/:hypothesisId/request-evidence', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);

      // Get hypothesis to find dataset domain
      const hypothesis = await dbManager.getHypothesis(hypothesisId);
      let datasetDomain = null;

      if (hypothesis?.run_id) {
        const run = await dbManager.getRun(hypothesis.run_id);
        if (run?.dataset_id) {
          const dataset = state.datasets[run.dataset_id];
          if (dataset?.normalization?.semanticMetadata?.domain) {
            datasetDomain = dataset.normalization.semanticMetadata.domain;
            console.log(`Dataset domain for hypothesis ${hypothesisId}: ${datasetDomain}`);
          }
        }
      }

      const evidenceRequest = await hypothesisAgent.requestEvidence(hypothesisId, { datasetDomain });

      res.json({
        success: true,
        evidence_request: evidenceRequest
      });
    } catch (error) {
      console.error('Error requesting evidence:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // POST /api/hypotheses/:hypothesisId/evaluate - Evaluate hypothesis
  router.post('/hypotheses/:hypothesisId/evaluate', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);

      const evaluation = await hypothesisAgent.evaluateHypothesis(hypothesisId);

      res.json({
        success: true,
        evaluation
      });
    } catch (error) {
      console.error('Error evaluating hypothesis:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // POST /api/hypotheses/:hypothesisId/revise - Revise hypothesis
  router.post('/hypotheses/:hypothesisId/revise', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const { revisionReason } = req.body;

      if (!revisionReason) {
        return res.status(400).json({
          success: false,
          error: 'revisionReason is required'
        });
      }

      const newHypothesisId = await hypothesisAgent.reviseHypothesis(hypothesisId, revisionReason);

      res.json({
        success: true,
        new_hypothesis_id: newHypothesisId
      });
    } catch (error) {
      console.error('Error revising hypothesis:', error);
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
