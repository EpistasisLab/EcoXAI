/**
 * WikiService — LLM-maintained per-dataset knowledge base.
 *
 * Stores wiki files in SeaweedFS under wikis/{datasetId}/ with local filesystem
 * fallback at backend/data/wikis/{datasetId}/ for dev environments.
 *
 * Files per dataset:
 *   portrait.md   - LLM-written data narrative, compiled on upload
 *   insights.md   - Accumulated agent run discoveries (append-only)
 *   qa.md         - Filed Q&A responses
 *   meta.json     - Timestamps, counts
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const WIKIS_DIR = path.join(__dirname, '../data/wikis');

// Ensure wiki root exists at startup
if (!fs.existsSync(WIKIS_DIR)) {
  fs.mkdirSync(WIKIS_DIR, { recursive: true });
}

class WikiService {
  constructor() {
    this.anthropic = null;
    this.model = null;
    this._initClient();
  }

  _initClient() {
    const useFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY === '1';

    if (useFoundry) {
      const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
      const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE || 'cbm-staff-gpt4';
      const model = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
      if (!apiKey) {
        console.warn('[Wiki] CLAUDE_CODE_USE_FOUNDRY=1 but ANTHROPIC_FOUNDRY_API_KEY not set — falling back to direct API');
      } else {
        try {
          const AnthropicFoundry = require('@anthropic-ai/foundry-sdk').default;
          this.anthropic = new AnthropicFoundry({ apiKey, resource });
          this.model = model;
          return;
        } catch (e) {
          console.warn('[Wiki] Failed to init Foundry client:', e.message);
        }
      }
    }

    // Direct Anthropic API (default or Foundry fallback)
    // When using a local model via ANTHROPIC_BASE_URL, an API key may not be required;
    // use a placeholder so the SDK initializes successfully.
    const apiKey = process.env.ANTHROPIC_API_KEY || (process.env.ANTHROPIC_BASE_URL ? 'local' : null);
    if (!apiKey) return;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const clientOpts = { apiKey };
      if (process.env.ANTHROPIC_BASE_URL) clientOpts.baseURL = process.env.ANTHROPIC_BASE_URL;
      this.anthropic = new Anthropic(clientOpts);
      this.model = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
    } catch (e) {
      console.warn('[Wiki] Failed to init Anthropic client:', e.message);
    }
  }

  // ── Storage helpers (SeaweedFS primary, local filesystem fallback) ──────────

  _wikiDir(datasetId) {
    return path.join(WIKIS_DIR, datasetId);
  }

  _ensureDir(datasetId) {
    const dir = this._wikiDir(datasetId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _read(datasetId, filename) {
    const fp = path.join(this._wikiDir(datasetId), filename);
    return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : null;
  }

  _write(datasetId, filename, content) {
    this._ensureDir(datasetId);
    fs.writeFileSync(path.join(this._wikiDir(datasetId), filename), content, 'utf-8');
  }

  _append(datasetId, filename, content) {
    this._ensureDir(datasetId);
    fs.appendFileSync(path.join(this._wikiDir(datasetId), filename), content, 'utf-8');
  }

  async _readMeta(datasetId) {
    const raw = await this._read(datasetId, 'meta.json');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  async _writeMeta(datasetId, meta) {
    await this._write(datasetId, 'meta.json', JSON.stringify(meta, null, 2));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Return all wiki sections for a dataset. Now async.
   */
  async getWiki(datasetId) {
    const [portrait, insights, qa, meta] = await Promise.all([
      this._read(datasetId, 'portrait.md'),
      this._read(datasetId, 'insights.md'),
      this._read(datasetId, 'qa.md'),
      this._readMeta(datasetId),
    ]);
    return { portrait, insights, qa, meta };
  }

  /**
   * Compile (or recompile) the data portrait.
   * Called eagerly after normalization completes on upload.
   * @param {string} datasetId
   * @param {Object} datasetMeta - From state.datasets[id]
   * @param {Object} context    - { structure, semantic, confidence, provenance }
   */
  async compilePortrait(datasetId, datasetMeta, context) {
    let portrait;
    let usedLLM = false;

    if (this.anthropic) {
      try {
        const prompt = this._buildPortraitPrompt(datasetMeta, context);
        const response = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        portrait = response.content.find(b => b.type === 'text')?.text;
        usedLLM = !!portrait;
      } catch (err) {
        console.warn(`[Wiki] LLM portrait failed for ${datasetId}, using fallback:`, err.message);
      }
    }

    if (!portrait) {
      portrait = this._buildFallbackPortrait(datasetMeta, context);
    }

    await this._write(datasetId, 'portrait.md', portrait);
    const meta = await this._readMeta(datasetId);
    meta.portraitCompiledAt = new Date().toISOString();
    meta.usedLLM = usedLLM;
    await this._writeMeta(datasetId, meta);

    console.log(`[Wiki] Portrait compiled for ${datasetId} (LLM: ${usedLLM})`);
  }

  /**
   * File a discovery chapter from a completed agent run.
   * Called async from jobs.js onComplete.
   * @param {string} datasetId
   * @param {string} jobId
   * @param {string} jobTitle
   * @param {string|null} reportContent  - Contents of report.md artifact
   * @param {Array|null}  featureData    - Parsed feature_importance_results.json
   */
  async fileDiscovery(datasetId, jobId, jobTitle, reportContent, featureData) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let chapter = `\n---\n\n## ${ts} — ${jobTitle || `Job ${jobId}`}\n\n`;

    if (reportContent) {
      const trimmed = reportContent.length > 3000
        ? reportContent.slice(0, 3000) + '\n\n*[truncated — full artifact in job workspace]*'
        : reportContent;
      chapter += trimmed + '\n\n';
    } else {
      chapter += `*Agent completed. No report.md generated.*\n\n`;
    }

    if (featureData && featureData.length > 0) {
      chapter += `### Top Features\n\n| Feature | Importance |\n|---|---|\n`;
      const sorted = [...featureData].sort((a, b) => (b.importance || 0) - (a.importance || 0));
      sorted.slice(0, 10).forEach(f => {
        const imp = typeof f.importance === 'number' ? f.importance.toFixed(4) : (f.importance ?? '—');
        chapter += `| ${f.feature || f.name || '?'} | ${imp} |\n`;
      });
      chapter += '\n';
    }

    const existing = await this._read(datasetId, 'insights.md');
    if (!existing) {
      await this._write(datasetId, 'insights.md',
        `# Discoveries\n\n*Agent run summaries are automatically filed here.*\n${chapter}`);
    } else {
      await this._append(datasetId, 'insights.md', chapter);
    }

    const meta = await this._readMeta(datasetId);
    meta.lastDiscoveryAt = new Date().toISOString();
    meta.discoveryCount = (meta.discoveryCount || 0) + 1;
    await this._writeMeta(datasetId, meta);

    console.log(`[Wiki] Discovery filed for ${datasetId} from job ${jobId}`);
  }

  /**
   * Answer a question about the dataset using the wiki as context.
   * Files the Q&A into qa.md.
   */
  async answerAndFileQA(datasetId, question, datasetMeta) {
    if (!this.anthropic) {
      const answer = '*AI unavailable. Cannot answer questions.*';
      await this._fileQAEntry(datasetId, question, answer);
      return answer;
    }

    const wiki = await this.getWiki(datasetId);
    const contextParts = [
      wiki.portrait && `## Data Portrait\n${wiki.portrait.slice(0, 3000)}`,
      wiki.insights && `## Recent Discoveries\n${wiki.insights.slice(-2000)}`,
    ].filter(Boolean).join('\n\n');

    const prompt = `You are answering a question about a dataset based on its knowledge base.

Dataset: ${datasetMeta?.filename || datasetId} (${datasetMeta?.recordCount || '?'} records, ${datasetMeta?.columnCount || '?'} columns)

${contextParts}

Question: ${question}

Answer concisely and factually based only on the information above. If the answer isn't in the knowledge base, say so clearly and suggest what analysis could help answer it.`;

    let answer;
    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      answer = response.content.find(b => b.type === 'text')?.text ?? '*No response generated*';
    } catch (err) {
      answer = `*Failed to generate answer: ${err.message}*`;
    }

    this._fileQAEntry(datasetId, question, answer);
    return answer;
  }

  async _fileQAEntry(datasetId, question, answer) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = `\n---\n\n**${ts}**\n\n**Q:** ${question}\n\n**A:** ${answer}\n\n`;
    const existing = await this._read(datasetId, 'qa.md');
    if (!existing) {
      await this._write(datasetId, 'qa.md',
        `# Q&A\n\n*Questions and answers are filed here as you explore this dataset.*\n${entry}`);
    } else {
      await this._append(datasetId, 'qa.md', entry);
    }
  }

  /**
   * Refresh the portrait by incorporating accumulated insights.
   * Called after each analysis job completes for the dataset.
   * @param {string} datasetId
   * @param {Object} datasetMeta - From state.datasets[id]
   * @param {Object} context    - { structure, semantic, confidence, provenance }
   */
  async refreshPortrait(datasetId, datasetMeta, context) {
    if (!this.anthropic) {
      console.log(`[Wiki] No AI client, skipping portrait refresh for ${datasetId}`);
      return;
    }

    const [currentPortrait, insights] = await Promise.all([
      this._read(datasetId, 'portrait.md'),
      this._read(datasetId, 'insights.md'),
    ]);

    // Nothing to refresh if there's no portrait yet or no new insights
    if (!currentPortrait || !insights) return;

    try {
      const prompt = this._buildRefreshPortraitPrompt(datasetMeta, context, currentPortrait, insights);
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const updatedPortrait = response.content.find(b => b.type === 'text')?.text;
      if (!updatedPortrait) return;
      await this._write(datasetId, 'portrait.md', updatedPortrait);

      const meta = await this._readMeta(datasetId);
      meta.portraitRefreshedAt = new Date().toISOString();
      meta.portraitRefreshCount = (meta.portraitRefreshCount || 0) + 1;
      await this._writeMeta(datasetId, meta);

      console.log(`[Wiki] Portrait refreshed for ${datasetId}`);
    } catch (err) {
      console.warn(`[Wiki] Portrait refresh failed for ${datasetId}:`, err.message);
    }
  }

  // ── Prompt builders ────────────────────────────────────────────────────────

  _buildPortraitPrompt(datasetMeta, context) {
    const { structure, semantic, confidence } = context || {};

    // Build a compact summary of structure to avoid huge prompts
    const colSummary = (structure?.columns || []).slice(0, 30).map(c =>
      `${c.name || c}: ${c.type || 'unknown'}`
    ).join(', ');

    return `You are a data scientist writing a wiki page for a dataset. Write a concise, insightful markdown portrait that helps someone quickly understand what this dataset contains and what it's useful for.

Dataset: ${datasetMeta.filename}
Records: ${datasetMeta.recordCount} | Columns: ${datasetMeta.columnCount} | Format: ${datasetMeta.type}
Domain: ${semantic?.domain || 'unknown'}
Columns: ${colSummary || 'N/A'}
Overall confidence: ${confidence?.overall_confidence != null ? Math.round(confidence.overall_confidence * 100) + '%' : 'N/A'}
Entities: ${JSON.stringify(semantic?.entities || [])}
Time range: ${JSON.stringify(semantic?.time_range || null)}
Units: ${JSON.stringify(semantic?.units || [])}

Write the wiki portrait as markdown with these sections:
- **Overview** — 2–3 sentences on what this dataset is and what questions it can answer
- **Domain** — the scientific/business context and why this data matters
- **Columns** — a concise markdown table: Name | Type | Description (key columns only, max 20 rows)
- **Data Quality** — brief assessment of completeness and reliability based on confidence scores
- **Key Observations** — 3–5 bullet points of interesting characteristics, patterns, or potential uses

Write in present tense. Be specific and grounded in the actual metadata — do not invent facts that aren't there. Avoid generic filler.`;
  }

  _buildRefreshPortraitPrompt(datasetMeta, context, currentPortrait, insights) {
    const { semantic, confidence } = context || {};

    // Take the most recent insights (last ~4000 chars) to keep prompt manageable
    const recentInsights = insights.length > 4000
      ? insights.slice(-4000)
      : insights;

    return `You are a data scientist updating a wiki portrait for a dataset. The portrait was originally written when the dataset was uploaded, but since then multiple analysis jobs have been run that produced new discoveries.

Your task: Rewrite the portrait to incorporate the new findings while keeping the same structure. The updated portrait should reflect what we NOW KNOW about this dataset — not just its static metadata, but the insights gained from analysis.

## Dataset Metadata
- Filename: ${datasetMeta.filename}
- Records: ${datasetMeta.recordCount} | Columns: ${datasetMeta.columnCount}
- Domain: ${semantic?.domain || 'unknown'}
- Confidence: ${confidence?.overall_confidence != null ? Math.round(confidence.overall_confidence * 100) + '%' : 'N/A'}

## Current Portrait
${currentPortrait}

## Analysis Discoveries (newest at bottom)
${recentInsights}

## Instructions
Rewrite the portrait incorporating the discoveries above. Keep these sections:
- **Overview** — What this dataset is AND what has been learned from it so far
- **Domain** — Scientific/business context, enriched with analysis findings
- **Columns** — Key columns table (update descriptions if analysis revealed their roles)
- **Data Quality** — Assessment including any quality issues discovered during analysis
- **Key Observations** — Replace speculative observations with confirmed findings from analysis
- **Analysis Progress** — NEW section: brief summary of what has been tested, what worked, what's left to explore

Write in present tense. Be specific and grounded — prefer confirmed findings over speculation. Keep it concise.`;
  }

  _buildFallbackPortrait(datasetMeta, context) {
    const semantic = context?.semantic || {};
    const structure = context?.structure || {};
    const confidence = context?.confidence || {};
    const columns = structure.columns || [];

    let md = `## Overview\n\n`;
    md += `This dataset contains **${datasetMeta.recordCount} records** across **${datasetMeta.columnCount} columns**`;
    if (semantic.domain && semantic.domain !== 'general') {
      md += ` in the **${semantic.domain}** domain`;
    }
    md += `.\n\n`;

    if (columns.length > 0) {
      md += `## Columns\n\n| Name | Type |\n|---|---|\n`;
      columns.slice(0, 20).forEach(col => {
        md += `| ${col.name || col} | ${col.type || 'unknown'} |\n`;
      });
      md += '\n';
    }

    if (confidence.overall_confidence != null) {
      md += `## Data Quality\n\nOverall confidence score: **${Math.round(confidence.overall_confidence * 100)}%**\n\n`;
    }

    if (semantic.entities && semantic.entities.length > 0) {
      md += `## Key Entities\n\n${semantic.entities.slice(0, 10).join(', ')}\n\n`;
    }

    return md;
  }
}

module.exports = new WikiService();
