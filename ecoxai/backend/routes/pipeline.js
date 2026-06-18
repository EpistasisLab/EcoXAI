'use strict';

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '../skills');

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

  router.put('/pipeline/stages/:stageId', (req, res) => {
    const { stageId } = req.params;
    const { skill, prompt, name, auto } = req.body || {};
    try {
      const updated = orchestrator.updateStage(stageId, { skill, prompt, name, auto });
      res.json({ success: true, stage: updated });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.get('/pipeline/skills', async (req, res) => {
    try {
      const skills = [];
      const visibilities = await fs.readdir(SKILLS_DIR);
      for (const vis of visibilities) {
        const visPath = path.join(SKILLS_DIR, vis);
        const stat = await fs.stat(visPath).catch(() => null);
        if (!stat?.isDirectory()) continue;
        const names = await fs.readdir(visPath);
        for (const name of names) {
          const skillStat = await fs.stat(path.join(visPath, name)).catch(() => null);
          if (skillStat?.isDirectory()) skills.push({ id: `${vis}:${name}`, visibility: vis, name });
        }
      }
      res.json({ success: true, skills });
    } catch {
      res.json({ success: true, skills: [] });
    }
  });

  router.post('/pipeline/skills', async (req, res) => {
    const { visibility, name, content } = req.body || {};
    if (!visibility || !name) {
      return res.status(400).json({ success: false, error: 'visibility and name are required' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(visibility) || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ success: false, error: 'visibility and name may only contain letters, numbers, hyphens, and underscores' });
    }
    const skillDir = path.join(SKILLS_DIR, visibility, name);
    try {
      await fs.stat(skillDir);
      return res.status(409).json({ success: false, error: `Skill "${visibility}:${name}" already exists` });
    } catch { /* does not exist — proceed */ }
    const defaultContent = typeof content === 'string' ? content : `---
name: ${name}
description:
when:
visibility: ${visibility}
tags: []
author: user
version: 1.0.0
---

## Instructions

Describe what the agent should do here.
`;
    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), defaultContent, 'utf8');
      res.json({ success: true, skill: { id: `${visibility}:${name}`, visibility, name } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/pipeline/skills/:visibility/:name/content', async (req, res) => {
    const { visibility, name } = req.params;
    const skillPath = path.join(SKILLS_DIR, visibility, name, 'SKILL.md');
    try {
      const content = await fs.readFile(skillPath, 'utf8');
      res.json({ success: true, content });
    } catch (err) {
      res.status(404).json({ success: false, error: 'Skill not found' });
    }
  });

  router.put('/pipeline/skills/:visibility/:name/content', async (req, res) => {
    const { visibility, name } = req.params;
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ success: false, error: 'content must be a string' });
    }
    const skillDir = path.join(SKILLS_DIR, visibility, name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    try {
      await fs.stat(skillDir);
      await fs.writeFile(skillPath, content, 'utf8');
      res.json({ success: true });
    } catch (err) {
      res.status(404).json({ success: false, error: 'Skill directory not found' });
    }
  });

  return router;
}

module.exports = createPipelineRoutes;
