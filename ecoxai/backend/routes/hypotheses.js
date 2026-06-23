'use strict';

const express = require('express');
const embeddingService = require('../services/embeddingService');

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
        // Async embed — fire-and-forget, never blocks the response
        const textToEmbed = h.hypothesis_text;
        const idToEmbed = hypothesisId;
        setImmediate(async () => {
          try {
            const vec = await embeddingService.embed(textToEmbed);
            dbManager.saveEmbedding(idToEmbed, vec);
          } catch (_) {}
        });
      }

      broadcast({ type: 'DATABASE_UPDATE', entity: 'hypotheses', jobId: job_id });
      res.json({ success: true, created });
    } catch (error) {
      console.error('Error creating hypotheses:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/hypotheses/graph — must be registered before /:hypothesisId wildcard
  router.get('/hypotheses/graph', async (req, res) => {
    try {
      const hypotheses = await dbManager.listHypotheses({ limit: 500 });
      const embeddedIds = dbManager.getEmbeddedIds();

      const nodes = hypotheses.map(h => ({
        id: `h-${h.hypothesis_id}`,
        label: (h.hypothesis_text || '').slice(0, 80),
        type: 'hypothesis',
        category: h.hypothesis_type || 'unknown',
        confidence: h.confidence_score ?? null,
        status: h.status || 'proposed',
        feature_name: h.feature_name || null,
        hasEmbedding: embeddedIds.has(h.hypothesis_id),
      }));

      const edgeMap = new Map();
      const embeddedHyps = hypotheses.filter(h => embeddedIds.has(h.hypothesis_id));
      for (const h of embeddedHyps) {
        const buf = dbManager.getEmbeddingBuffer(h.hypothesis_id);
        if (!buf) continue;
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const neighbors = dbManager.searchSimilar(vec, 6);
        for (const nb of neighbors) {
          const nbId = Number(nb.hypothesis_id);
          if (nbId === h.hypothesis_id) continue;
          if (nb.distance > 0.8) continue;
          const key = `${Math.min(h.hypothesis_id, nbId)}-${Math.max(h.hypothesis_id, nbId)}`;
          if (!edgeMap.has(key)) {
            edgeMap.set(key, {
              source: `h-${h.hypothesis_id}`,
              target: `h-${nbId}`,
              relation: 'semantic',
              strength: parseFloat((1 - nb.distance / 1.414).toFixed(3)),
            });
          }
        }
      }
      const links = [...edgeMap.values()].sort((a, b) => b.strength - a.strength).slice(0, 300);
      res.json({ nodes, links });
    } catch (error) {
      console.error('Error building hypothesis graph:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/hypotheses/similar?q=<text>&k=10 — must be before /:hypothesisId wildcard
  router.get('/hypotheses/similar', async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      const k = Math.min(parseInt(req.query.k) || 10, 50);
      if (!q) return res.status(400).json({ success: false, error: 'q is required' });

      const vec = await embeddingService.embed(q);
      const matches = dbManager.searchSimilar(vec, k);
      const hyps = await dbManager.listHypotheses({ limit: 500 });
      const hypMap = new Map(hyps.map(h => [h.hypothesis_id, h]));
      const hypotheses = matches
        .map(m => {
          const h = hypMap.get(Number(m.hypothesis_id));
          if (!h) return null;
          return { ...h, similarity: parseFloat((1 - (m.distance ** 2) / 2).toFixed(4)) };
        })
        .filter(Boolean);

      res.json({ success: true, hypotheses });
    } catch (error) {
      console.error('Error in hypothesis similarity search:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/hypotheses/export/csv — must be before /:hypothesisId wildcard
  router.get('/hypotheses/export/csv', async (req, res) => {
    try {
      const hypotheses = await dbManager.listHypotheses({ limit: 9999 });

      const COLUMNS = [
        'hypothesis_id', 'hypothesis_text', 'status', 'hypothesis_type',
        'confidence_score', 'feature_name', 'expected_metric',
        'expected_importance', 'actual_importance', 'evaluation_reasoning',
        'conclusion_text', 'graph_source', 'extracted_at', 'run_id',
      ];

      function csvField(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }

      const lines = [COLUMNS.join(',')];
      for (const h of hypotheses) {
        lines.push(COLUMNS.map(col => csvField(h[col])).join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="hypotheses.csv"');
      res.send(lines.join('\r\n'));
    } catch (error) {
      console.error('Error exporting hypotheses CSV:', error);
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

  // GET /api/hypotheses/:id/similar?k=10 — neighbor lookup by hypothesis ID
  router.get('/hypotheses/:hypothesisId/similar', async (req, res) => {
    try {
      const hypothesisId = parseInt(req.params.hypothesisId);
      const k = Math.min(parseInt(req.query.k) || 10, 50);

      const buf = dbManager.getEmbeddingBuffer(hypothesisId);
      if (!buf) {
        return res.status(404).json({ success: false, error: 'No embedding for this hypothesis yet' });
      }
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const matches = dbManager.searchSimilar(vec, k + 1); // +1 to exclude self

      const hyps = await dbManager.listHypotheses({ limit: 500 });
      const hypMap = new Map(hyps.map(h => [h.hypothesis_id, h]));

      const hypotheses = matches
        .filter(m => Number(m.hypothesis_id) !== hypothesisId)
        .slice(0, k)
        .map(m => {
          const h = hypMap.get(Number(m.hypothesis_id));
          if (!h) return null;
          return { ...h, similarity: parseFloat((1 - (m.distance ** 2) / 2).toFixed(4)) };
        })
        .filter(Boolean);

      res.json({ success: true, hypotheses });
    } catch (error) {
      console.error('Error getting hypothesis neighbors:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/hypotheses/embed — bulk embed all un-embedded hypotheses
  router.post('/hypotheses/embed', async (req, res) => {
    try {
      const force = req.query.force === 'true';
      const hyps = await dbManager.listHypotheses({ limit: 500 });
      const embeddedIds = force ? new Set() : dbManager.getEmbeddedIds();

      const toEmbed = hyps.filter(h => !embeddedIds.has(h.hypothesis_id));
      let embedded = 0;
      let errors = 0;
      for (const h of toEmbed) {
        try {
          const vec = await embeddingService.embed(h.hypothesis_text);
          dbManager.saveEmbedding(h.hypothesis_id, vec);
          embedded++;
        } catch (_) { errors++; }
      }

      res.json({ success: true, embedded, skipped: hyps.length - toEmbed.length, errors });
    } catch (error) {
      console.error('Error bulk embedding hypotheses:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = createHypothesesRoutes;
