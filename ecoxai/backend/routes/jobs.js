'use strict';

const express = require('express');
const path = require('path');
const router = express.Router();

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.py': 'text/x-python',
};

function createJobsRoutes({ state, saveState, broadcast, findJob, updateJob, containerManager, volumeManager }) {

  router.post('/jobs/:id/stop', async (req, res) => {
    const job = findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'in-progress') return res.status(400).json({ error: 'Job is not running' });
    try {
      await containerManager.stopJob(req.params.id);
      volumeManager.deleteWorkspaceVolume(req.params.id)
        .catch(err => console.warn(`[Volume] Cleanup failed for ${req.params.id}:`, err.message));
      updateJob(req.params.id, { status: 'failed', exitCode: -1, completedAt: new Date().toISOString() });
      broadcast({ type: 'JOB_STOPPED', jobId: req.params.id });
      broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/jobs/:id', async (req, res) => {
    const job = findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Stop container if running
    if (job.status === 'in-progress') {
      await containerManager.stopJob(req.params.id).catch(() => {});
    }

    // Always attempt volume cleanup (silently ignores missing volumes)
    volumeManager.deleteWorkspaceVolume(req.params.id)
      .catch(err => console.warn(`[Volume] Cleanup failed for ${req.params.id}:`, err.message));

    // Remove from state
    state.jobs = state.jobs.filter(j => j.id !== req.params.id);
    saveState();
    broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
    res.json({ success: true });
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

    const ext = path.extname(filename).toLowerCase();
    const contentType = CONTENT_TYPES[ext];

    try {
      const assetManager = require('../services/assetManager');
      const content = await assetManager.readJobArtifact(job.id, job.title, filename);
      if (contentType) res.set('Content-Type', contentType);
      return res.send(content);
    } catch (_) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
  });

  return router;
}

module.exports = createJobsRoutes;
