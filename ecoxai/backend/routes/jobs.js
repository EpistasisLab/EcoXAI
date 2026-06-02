'use strict';

const express = require('express');
const router = express.Router();

function createJobsRoutes({ state, saveState, broadcast, findJob, updateJob, createJobFromData, containerManager, volumeManager, dbManager, upload, startJobExecution }) {

  router.post('/jobs', async (req, res) => {
    try {
      const { title, prompt, datasetId, priority, testingHypothesisId } = req.body;
      if (!title) return res.status(400).json({ error: 'Title is required' });

      const newJob = {
        id: `J${Date.now()}`,
        title,
        priority: priority || 'Medium',
        status: 'todo',
        assignee: null,
        prompt: prompt || '',
        datasetId: datasetId || null,
        selectedSkills: [],
        skillsInvoked: [],
        output: '',
        artifacts: [],
        exitCode: null,
        startedAt: null,
        completedAt: null,
        containerId: null,
        createdAt: new Date().toISOString(),
        testingHypothesisId: testingHypothesisId || null,
      };

      state.jobs.push(newJob);
      saveState();
      broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
      res.json({ success: true, job: newJob });
      console.log(`✓ Created job ${newJob.id}: ${newJob.title}`);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/jobs', (req, res) => { res.json({ jobs: state.jobs }); });

  router.get('/jobs/:id', (req, res) => {
    const job = findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  router.patch('/jobs/:id', (req, res) => {
    const job = updateJob(req.params.id, req.body);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
    res.json({ success: true, job });
  });

  router.delete('/jobs/:id', async (req, res) => {
    const index = state.jobs.findIndex(j => j.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Job not found' });
    state.jobs.splice(index, 1);
    saveState();
    broadcast({ type: 'JOB_UPDATE', jobs: state.jobs });
    res.json({ success: true });
  });

  router.post('/jobs/:id/execute', async (req, res) => {
    try {
      const result = await startJobExecution(req.params.id);
      if (!result.success) return res.status(result.status || 500).json({ error: result.error });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

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

  router.get('/jobs/:id/runs', async (req, res) => {
    try {
      if (!dbManager) return res.status(503).json({ error: 'Database unavailable' });
      const runs = await dbManager.listRuns({ job_id: req.params.id, limit: 20 });
      res.json({ success: true, runs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = createJobsRoutes;
