'use strict';

const express = require('express');
const router = express.Router();

function createJobsRoutes({ state, saveState, broadcast, findJob, updateJob, containerManager, volumeManager }) {

  router.post('/jobs/:id/stop', async (req, res) => {
    const job = findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'in-progress') return res.status(400).json({ error: 'Job is not running' });
    try {
      await containerManager.stopJob(req.params.id);
      updateJob(req.params.id, { status: 'failed', exitCode: -1, completedAt: new Date().toISOString() });
      broadcast({ type: 'JOB_STOPPED', jobId: req.params.id });
      broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/jobs/:id/artifacts', async (req, res) => {
    const job = findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, artifacts: job.artifacts || [] });
  });

  router.get('/jobs/:id/artifacts/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const job = findJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
      const content = await volumeManager.readArtifact(id, filename);
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } catch (error) {
      res.status(404).json({ error: 'Artifact not found' });
    }
  });

  return router;
}

module.exports = createJobsRoutes;
