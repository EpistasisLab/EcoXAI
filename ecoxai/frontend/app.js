'use strict';

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'ecoxai_lean_settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}

function defaultSettings() {
  return {
    host: `${location.hostname}:8081`,
    hypLimit: 200,
    hypRefresh: 30,
    autoScroll: true,
  };
}

let settings = { ...defaultSettings(), ...loadSettings() };

function apiBase() { return `http://${settings.host}/api`; }
function wsUrl()   { return `ws://${settings.host}`; }

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  datasets: [],
  jobs: [],
  hypotheses: [],
  pipeline: { autoMode: true, stages: [] },
  selectedDatasetId: null,
  selectedJobId: null,
  activeJobLogs: {},
  activeView: 'datasets',
  hypSort: 'conf-desc',
  hypGroup: 'status',
  hypSearch: '',
  selectedHypId: null,
  hypDetailTab: 'logs',
  hypDetailAsset: null,
  selectedAssetFile: null,
  selectedDetailTab: 'logs',
  serverBudget: { totalCostUsd: 0, jobCount: 0, sessions: [] },
  serverSettings: { budgetLimitUsd: 10 },
};

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;
let hypRefreshTimer = null;

function connectWS() {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    document.getElementById('connection-banner').classList.remove('show');
    clearTimeout(wsReconnectTimer);
  };

  ws.onmessage = (event) => {
    try { handleMessage(JSON.parse(event.data)); }
    catch (e) { console.warn('[WS] Parse error:', e); }
  };

  ws.onclose = () => {
    document.getElementById('connection-banner').classList.add('show');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => { ws.close(); };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'FULL_STATE':
      if (msg.jobs)     state.jobs     = msg.jobs;
      if (msg.datasets) state.datasets = msg.datasets;
      if (msg.pipeline) { state.pipeline = msg.pipeline; renderPipeline(); }
      if (msg.budget)   { state.serverBudget = msg.budget; renderBudgetStatus(); }
      if (msg.settings) { state.serverSettings = msg.settings; applySettingsToForm(); }
      renderDatasets();
      loadHypotheses();
      break;

    case 'JOB_UPDATE':
      state.jobs = msg.jobs || state.jobs;
      renderPipeline();
      renderHypDetail();
      break;

    case 'JOB_OUTPUT':
      if (!state.activeJobLogs[msg.jobId]) state.activeJobLogs[msg.jobId] = '';
      state.activeJobLogs[msg.jobId] += msg.chunk;
      appendJobLog(msg.jobId, msg.chunk);
      appendHypJobLog(msg.jobId, msg.chunk);
      break;

    case 'JOB_COMPLETED':
    case 'JOB_FAILED':
    case 'JOB_STOPPED': {
      const finalStatus = msg.type === 'JOB_COMPLETED' ? 'completed' : 'failed';
      updateStageFromJob(msg.jobId, finalStatus);
      if (state.selectedHypId) {
        const hyp = state.hypotheses.find(h => h.hypothesis_id === state.selectedHypId);
        const detailJob = hyp ? findHypTestJob(hyp) : null;
        if (detailJob && detailJob.id === msg.jobId) renderHypDetail();
      }
      break;
    }

    case 'PIPELINE_STAGE_UPDATE':
      updateStageDisplay(msg);
      if (msg.autoMode !== undefined) updateAutoModeBadge(msg.autoMode);
      break;

    case 'DATASETS_PROMOTED':
      if (msg.datasets) state.datasets = msg.datasets;
      renderDatasets();
      break;

    case 'DATABASE_UPDATE':
      if (msg.entity === 'hypotheses') loadHypotheses();
      break;

    case 'HYPOTHESIS_UPDATE':
    case 'HYPOTHESIS_DELETED':
      if (msg.type === 'HYPOTHESIS_DELETED' && state.selectedHypId === msg.hypothesisId) {
        state.selectedHypId = null;
      }
      loadHypotheses();
      break;

    case 'WIKI_UPDATE':
      if (msg.datasetId === state.selectedDatasetId) loadWiki(msg.datasetId);
      break;

    case 'BUDGET_UPDATE':
      if (msg.budget) { state.serverBudget = msg.budget; renderBudgetStatus(); }
      break;

    case 'SETTINGS_UPDATE':
      if (msg.settings) { state.serverSettings = msg.settings; applySettingsToForm(); renderBudgetStatus(); }
      break;
  }
}

// ── View switching ─────────────────────────────────────────────────────────────
function switchView(name) {
  state.activeView = name;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('active', el.id === `view-${name}`);
  });
}

document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => switchView(el.dataset.view));
});

// ── Dataset view ───────────────────────────────────────────────────────────────
function renderDatasets() {
  const list  = document.getElementById('dataset-list');
  const count = document.getElementById('ds-count');
  const dot   = document.getElementById('ds-status');

  count.textContent = state.datasets.length;
  dot.className = 'status-dot' + (state.datasets.length > 0 ? '' : ' inactive');

  if (state.datasets.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>No datasets yet.<br>Upload a CSV/JSON/Feather file.</p></div>';
    return;
  }

  list.innerHTML = state.datasets.map(ds => {
    const conf = ds.normalization?.confidence ?? null;
    const confStr = conf !== null ? (conf * 100).toFixed(0) + '%' : '—';
    const confClass = conf !== null && conf < 0.7 ? 'ds-conf low' : 'ds-conf';
    const selected = ds.id === state.selectedDatasetId ? ' selected' : '';
    return `
      <div class="dataset-card${selected}" onclick="app.selectDataset('${ds.id}')">
        <div class="ds-name">${escHtml(ds.filename || ds.id)} <span class="ds-badge">${escHtml(ds.type || 'csv')}</span></div>
        <div class="ds-meta">
          <span>${(ds.recordCount || 0).toLocaleString()} rows</span>
          <span>${ds.columnCount || 0} cols</span>
          <span class="${confClass}">conf ${confStr}</span>
          ${ds.normalization?.domain ? `<span>${escHtml(ds.normalization.domain)}</span>` : ''}
          <span>${formatDate(ds.uploadedAt)}</span>
        </div>
      </div>`;
  }).join('');
}

async function loadWiki(datasetId) {
  const area = document.getElementById('wiki-area');
  if (!datasetId) { area.innerHTML = ''; return; }
  try {
    const resp = await fetch(`${apiBase()}/datasets/${datasetId}/wiki`);
    const data = await resp.json();
    if (!data.wiki) { area.innerHTML = ''; return; }
    const wiki = data.wiki;
    area.innerHTML = `
      <div class="wiki-section">
        <h4>Portrait</h4>
        ${renderMarkdown(wiki.portrait || '')}
        ${wiki.insights ? `<h4 style="margin-top:8px">Insights</h4>${renderMarkdown(wiki.insights || '')}` : ''}
      </div>`;
  } catch { area.innerHTML = ''; }
}

document.getElementById('file-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch(`${apiBase()}/upload/dataset`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
  e.target.value = '';
});

// ── Pipeline view ──────────────────────────────────────────────────────────────
const stageStatuses = {};
const JOB_STATUS_COLORS = {
  'in-progress': 'var(--yellow)',
  completed: 'var(--green)',
  failed: 'var(--red)',
  todo: 'var(--text-dim)',
};

function renderPipeline() {
  const stages = state.pipeline.stages || [];
  updateAutoModeBadge(state.pipeline.autoMode);

  const list = document.getElementById('stage-list');
  if (stages.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:24px"><div class="icon" style="font-size:24px">⚡</div><p>No pipeline stages yet.</p></div>';
    return;
  }

  list.innerHTML = stages.map(stage => {
    const ss = stageStatuses[stage.id];
    const status = ss?.status || 'idle';
    const icon = { running: '⚡', completed: '✓', failed: '✗', waiting: '⏸', idle: '○' }[status] || '○';

    const stageJobs = state.jobs.filter(j => j._stageId === stage.id);
    const jobsHtml = stageJobs.length === 0 ? '' : `
      <div class="stage-jobs">
        ${stageJobs.map(j => {
          const dot = JOB_STATUS_COLORS[j.status] || 'var(--text-dim)';
          const cost = j.totalCostUsd != null ? `<span class="stage-job-cost">$${j.totalCostUsd.toFixed(4)}</span>` : '';
          const turns = j.numTurns != null ? `<span class="stage-job-turns">${j.numTurns}t</span>` : '';
          const sel = state.selectedJobId === j.id ? ' selected' : '';
          return `<div class="stage-job${sel}" onclick="app.selectJob('${j.id}')">
            <span class="stage-job-dot" style="background:${dot}"></span>
            <span class="stage-job-status">${escHtml(j.status)}</span>
            ${cost}${turns}
            <span class="stage-job-id">${escHtml(j.id)}</span>
          </div>`;
        }).join('')}
      </div>`;

    return `
      <div class="stage-item ${status}" id="stage-${stage.id}">
        <div class="stage-header">
          <span class="stage-icon">${icon}</span>
          <span class="stage-name">${escHtml(stage.name)}</span>
          <span class="stage-status">${status}</span>
          ${ss?.datasetId && status !== 'completed' ? `<button class="btn" style="padding:2px 8px;font-size:10px;margin-left:auto" onclick="event.stopPropagation();app.triggerStage('${stage.id}','${ss.datasetId}')">Run</button>` : ''}
        </div>
        ${jobsHtml}
      </div>`;
  }).join('');
}

function updateStageDisplay(msg) {
  const { stageId, stageName, status, jobId, datasetId } = msg;
  stageStatuses[stageId] = { status, jobId, datasetId };
  renderPipeline();
  if (status === 'running' && jobId && state.activeView === 'pipeline') {
    app.selectJob(jobId);
  }
}

function updateStageFromJob(jobId, status) {
  for (const ss of Object.values(stageStatuses)) {
    if (ss.jobId === jobId) ss.status = status;
  }
  renderPipeline();
  if (state.selectedJobId === jobId) renderJobDetail(jobId);
}

function updateAutoModeBadge(autoMode) {
  const badge = document.getElementById('auto-badge');
  if (!badge) return;
  badge.textContent = autoMode ? 'AUTO' : 'PAUSED';
  badge.className = 'auto-badge ' + (autoMode ? 'on' : 'off');
}

function appendJobLog(jobId, chunk) {
  if (state.selectedJobId !== jobId || state.selectedDetailTab !== 'logs') return;
  const logEl = document.querySelector('#pane-logs .job-log');
  if (!logEl) return;
  logEl.textContent += chunk;
  if (logEl.textContent.length > 8000) {
    logEl.textContent = '...' + logEl.textContent.slice(-7800);
  }
  if (settings.autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function renderJobDetail(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;

  const detail = document.getElementById('pipeline-detail');
  const cost   = job.totalCostUsd != null ? `<span style="color:var(--green)">$${job.totalCostUsd.toFixed(4)}</span>` : '';
  const turns  = job.numTurns != null ? `<span>${job.numTurns} turns</span>` : '';
  const artCount = (job.artifacts || []).length;

  const logContent = escHtml((state.activeJobLogs[jobId] || job.output || '(no output yet)'));

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escHtml(job.title || jobId)}</div>
      <div class="detail-meta">
        <span class="status-badge ${escHtml(job.status || 'unknown')}">${escHtml(job.status || 'unknown')}</span>
        ${cost}${turns}
      </div>
    </div>
    <div class="detail-tabs">
      <div class="detail-tab ${state.selectedDetailTab === 'logs' ? 'active' : ''}" onclick="app.selectDetailTab('logs')">Logs</div>
      <div class="detail-tab ${state.selectedDetailTab === 'assets' ? 'active' : ''}" onclick="app.selectDetailTab('assets')">Assets <span style="color:var(--text-dim);font-size:10px">(${artCount})</span></div>
    </div>
    <div class="detail-body">
      <div class="detail-pane ${state.selectedDetailTab === 'logs' ? 'active' : ''}" id="pane-logs">
        <pre class="job-log">${logContent}</pre>
      </div>
      <div class="detail-pane ${state.selectedDetailTab === 'assets' ? 'active' : ''}" id="pane-assets">
        ${buildAssetsPane(job)}
      </div>
    </div>`;

  if (settings.autoScroll && state.selectedDetailTab === 'logs') {
    const logEl = detail.querySelector('.job-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
}

function buildAssetsPane(job) {
  const artifacts = job.artifacts || [];
  if (artifacts.length === 0) {
    return '<div class="empty-state" style="padding:20px"><div class="icon" style="font-size:24px">📄</div><p>No assets yet.</p></div>';
  }
  const items = artifacts.map(a => {
    const name = typeof a === 'string' ? a : (a.name || a.path || 'artifact');
    const sel = name === state.selectedAssetFile ? ' selected' : '';
    return `<div class="asset-file${sel}" onclick="app.loadAsset('${escHtml(job.id)}','${escAttr(name)}')">
      <span class="asset-file-name">${escHtml(name)}</span>
    </div>`;
  }).join('');
  return `<div class="asset-split">
    <div class="asset-list">${items}</div>
    <div class="asset-preview-area" id="asset-preview-area">
      <div style="font-size:12px;color:var(--text-dim);padding:8px">Select a file to preview</div>
    </div>
  </div>`;
}

async function loadAssetContent(jobId, filename) {
  state.selectedAssetFile = filename;

  // Update selected highlight without full re-render
  document.querySelectorAll('.asset-file').forEach(el => {
    el.classList.toggle('selected', el.querySelector('.asset-file-name')?.textContent === filename);
  });

  const previewArea = document.getElementById('asset-preview-area');
  if (!previewArea) return;
  previewArea.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-dim)"><span class="spinner"></span> Loading…</div>';

  try {
    if (isImageFile(filename)) {
      const url = `${apiBase()}/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`;
      previewArea.innerHTML = `<div class="asset-image-wrap"><img class="asset-image" src="${escAttr(url)}" alt="${escAttr(filename)}"></div>`;
      return;
    }

    const resp = await fetch(`${apiBase()}/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();

    if (filename.endsWith('.csv')) {
      previewArea.innerHTML = buildCsvTable(text);
    } else if (filename.endsWith('.json')) {
      let display = text;
      try { display = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      previewArea.innerHTML = `<pre class="asset-preview">${escHtml(display.slice(0, 10000))}</pre>`;
    } else if (filename.endsWith('.md')) {
      previewArea.innerHTML = renderMarkdown(text);
    } else {
      previewArea.innerHTML = `<pre class="asset-preview">${escHtml(text.slice(0, 10000))}</pre>`;
    }
  } catch (e) {
    previewArea.innerHTML = `<div style="padding:8px;font-size:12px;color:var(--red)">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function buildCsvTable(text) {
  const lines = text.trim().split('\n').slice(0, 52);
  if (!lines.length) return '<div class="empty-state">Empty file</div>';
  const headers = splitCsvRow(lines[0]);
  const rows    = lines.slice(1, 51).map(splitCsvRow);
  const thead = `<tr>${headers.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr>`;
  const tbody = rows.map(cells => `<tr>${cells.map(c => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="asset-table-wrap"><table class="asset-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
}

function splitCsvRow(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

// ── Hypotheses view ───────────────────────────────────────────────────────────
async function loadHypotheses() {
  try {
    const resp = await fetch(`${apiBase()}/hypotheses?limit=${settings.hypLimit}`);
    if (!resp.ok) return;
    const data = await resp.json();
    state.hypotheses = data.hypotheses || [];
    renderHypotheses();
    renderHypDetail();
  } catch (e) { console.warn('Failed to load hypotheses:', e); }
}

function renderHypotheses() {
  const list = document.getElementById('hypothesis-list');

  document.getElementById('hyp-count').textContent  = state.hypotheses.length;
  document.getElementById('stat-total').textContent  = state.hypotheses.length;
  document.getElementById('stat-supported').textContent = state.hypotheses.filter(h => h.status === 'supported').length;
  document.getElementById('stat-rejected').textContent  = state.hypotheses.filter(h => h.status === 'rejected').length;
  document.getElementById('stat-pending').textContent   = state.hypotheses.filter(h => !['supported','rejected'].includes(h.status)).length;

  if (state.hypotheses.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">🔬</div><p>No hypotheses yet.<br>Run the pipeline to generate them.</p></div>';
    return;
  }

  // Filter
  const q = state.hypSearch.toLowerCase();
  let hyps = q
    ? state.hypotheses.filter(h =>
        (h.hypothesis_text || '').toLowerCase().includes(q) ||
        (h.feature_name || '').toLowerCase().includes(q))
    : state.hypotheses;

  if (hyps.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><p>No results for your search.</p></div>';
    return;
  }

  hyps = sortHypotheses(hyps, state.hypSort);

  list.innerHTML = state.hypGroup === 'none'
    ? hyps.map(renderHypCard).join('')
    : renderGrouped(hyps, state.hypGroup);
}

const STATUS_ORDER = ['supported', 'evidence_collected', 'evaluated', 'test_requested', 'proposed', 'needs_more_data', 'rejected'];

function sortHypotheses(hyps, key) {
  return [...hyps].sort((a, b) => {
    switch (key) {
      case 'conf-desc': return (b.confidence_score ?? -1) - (a.confidence_score ?? -1);
      case 'conf-asc':  return (a.confidence_score ?? -1) - (b.confidence_score ?? -1);
      case 'status':    return (a.status || '').localeCompare(b.status || '');
      case 'type':      return (a.hypothesis_type || '').localeCompare(b.hypothesis_type || '');
      case 'feature':   return (a.feature_name || '').localeCompare(b.feature_name || '');
      case 'newest':    return (b.hypothesis_id || 0) - (a.hypothesis_id || 0);
      default: return 0;
    }
  });
}

function renderGrouped(hyps, groupKey) {
  const groups = {};
  for (const h of hyps) {
    const key = (groupKey === 'status' ? h.status : h.hypothesis_type) || 'unknown';
    (groups[key] = groups[key] || []).push(h);
  }

  let keys = Object.keys(groups);
  if (groupKey === 'status') {
    keys = [...STATUS_ORDER.filter(k => groups[k]), ...keys.filter(k => !STATUS_ORDER.includes(k))];
  } else {
    keys.sort();
  }

  return keys.map(key => `
    <div class="hyp-group" id="grp-${escAttr(key)}">
      <div class="hyp-group-header" onclick="app.toggleGroup('${escAttr(key)}')">
        <span class="hyp-group-caret">▼</span>
        <span class="status-badge ${escHtml(key)}">${escHtml(key)}</span>
        <span class="hyp-group-count">${groups[key].length}</span>
      </div>
      <div class="hyp-group-body">
        ${groups[key].map(renderHypCard).join('')}
      </div>
    </div>`).join('');
}

function renderHypCard(h) {
  const id = h.hypothesis_id;
  const selected = state.selectedHypId === id ? ' selected' : '';

  const conf = h.confidence_score != null
    ? `<span class="hyp-conf">conf ${(h.confidence_score * 100).toFixed(0)}%</span>`
    : '';
  const feat = h.feature_name
    ? `<span class="hyp-feature">${escHtml(h.feature_name)}</span>`
    : '';
  const type = h.hypothesis_type
    ? `<span class="type-badge">${escHtml(h.hypothesis_type)}</span>`
    : '';

  let importanceHtml = '';
  if (h.actual_importance != null) {
    const match = h.expected_importance != null && h.actual_importance >= h.expected_importance;
    importanceHtml = `<span class="importance-actual ${match ? 'match' : 'miss'}">actual: ${h.actual_importance.toFixed(3)}${h.expected_importance != null ? ` / exp: ${h.expected_importance.toFixed(3)}` : ''}</span>`;
  }

  return `
    <div class="hyp-card${selected}" onclick="app.selectHyp(${id})">
      <div class="hyp-text">${escHtml(h.hypothesis_text)}</div>
      <div class="hyp-meta">
        <span class="status-badge ${escHtml(h.status || 'proposed')}">${escHtml(h.status || 'proposed')}</span>
        ${conf}${type}${feat}${importanceHtml}
      </div>
    </div>`;
}

// ── Hypothesis detail panel ───────────────────────────────────────────────────

function findHypTestJob(hyp) {
  const datasetId = hyp.run_dataset_id || null;
  if (!datasetId) return state.jobs.find(j => j.id === hyp.job_id) || null;
  // Prefer the test stage job; fall back to the generate job
  const testJobs = state.jobs.filter(j => j._stageId === 'test' && j.datasetId === datasetId);
  if (testJobs.length > 0) {
    return testJobs.sort((a, b) =>
      (b.completedAt || b.startedAt || '') > (a.completedAt || a.startedAt || '') ? 1 : -1
    )[0];
  }
  return state.jobs.find(j => j.id === hyp.job_id) || null;
}

function appendHypJobLog(jobId, chunk) {
  if (!state.selectedHypId || state.hypDetailTab !== 'logs') return;
  const hyp = state.hypotheses.find(h => h.hypothesis_id === state.selectedHypId);
  const job = hyp ? findHypTestJob(hyp) : null;
  if (!job || job.id !== jobId) return;
  const logEl = document.getElementById('hyp-job-log');
  if (!logEl) return;
  logEl.textContent += chunk;
  if (logEl.textContent.length > 8000) logEl.textContent = '...' + logEl.textContent.slice(-7800);
  if (settings.autoScroll) logEl.scrollTop = logEl.scrollHeight;
}

function buildHypAssetsPane(job) {
  const artifacts = job.artifacts || [];
  if (!artifacts.length) {
    return '<div class="empty-state" style="padding:20px"><div class="icon" style="font-size:24px">📄</div><p>No assets yet.</p></div>';
  }
  const items = artifacts.map(a => {
    const name = typeof a === 'string' ? a : (a.name || a.path || 'artifact');
    const sel = name === state.hypDetailAsset ? ' selected' : '';
    return `<div class="asset-file${sel}" onclick="app.loadHypAsset('${escHtml(job.id)}','${escAttr(name)}')">
      <span class="asset-file-name">${escHtml(name)}</span>
    </div>`;
  }).join('');
  return `<div class="asset-split">
    <div class="asset-list">${items}</div>
    <div class="asset-preview-area" id="hyp-asset-preview">
      <div style="font-size:12px;color:var(--text-dim);padding:8px">Select a file to preview</div>
    </div>
  </div>`;
}

function renderHypDetail() {
  const panel = document.getElementById('hyp-detail');
  if (!panel) return;

  if (!state.selectedHypId) {
    panel.innerHTML = `<div class="detail-empty"><div style="font-size:32px;margin-bottom:8px">🔬</div><p>Select a hypothesis to view details</p></div>`;
    return;
  }

  const hyp = state.hypotheses.find(h => h.hypothesis_id === state.selectedHypId);
  if (!hyp) {
    panel.innerHTML = `<div class="detail-empty"><p>Hypothesis not found</p></div>`;
    return;
  }

  const job = findHypTestJob(hyp);
  const tab = state.hypDetailTab;

  const conf = hyp.confidence_score != null
    ? `<span class="hyp-conf">conf ${(hyp.confidence_score * 100).toFixed(0)}%</span>` : '';
  const feat = hyp.feature_name
    ? `<span class="hyp-feature">${escHtml(hyp.feature_name)}</span>` : '';
  const type = hyp.hypothesis_type
    ? `<span class="type-badge">${escHtml(hyp.hypothesis_type)}</span>` : '';

  let importanceHtml = '';
  if (hyp.actual_importance != null) {
    const match = hyp.expected_importance != null && hyp.actual_importance >= hyp.expected_importance;
    importanceHtml = `<span class="importance-actual ${match ? 'match' : 'miss'}">actual: ${hyp.actual_importance.toFixed(3)}${hyp.expected_importance != null ? ` / exp: ${hyp.expected_importance.toFixed(3)}` : ''}</span>`;
  }

  let extraDetails = '';
  if (hyp.evaluation_reasoning) extraDetails += `<div class="hyp-detail-row"><strong>Reasoning:</strong> <span>${escHtml(hyp.evaluation_reasoning)}</span></div>`;
  if (hyp.expected_metric) extraDetails += `<div class="hyp-detail-row"><strong>Expected metric:</strong> <span>${escHtml(hyp.expected_metric)}</span></div>`;
  if (hyp.graph_source) extraDetails += `<div class="hyp-detail-row"><strong>Source:</strong> <span>${escHtml(hyp.graph_source)}</span></div>`;

  let jobSectionHtml;
  if (job) {
    const isTestJob = job._stageId === 'test';
    const jobLabel = isTestJob ? 'Test Job' : 'Generate Job';
    const jCost = job.totalCostUsd != null ? `<span style="color:var(--green)">$${job.totalCostUsd.toFixed(4)}</span>` : '';
    const jTurns = job.numTurns != null ? `<span style="color:var(--text-dim)">${job.numTurns}t</span>` : '';
    const artCount = (job.artifacts || []).length;
    const logContent = escHtml(state.activeJobLogs[job.id] || job.output || '(no output yet)');

    jobSectionHtml = `
      <div class="hyp-job-section">
        <div class="hyp-job-header">
          <span class="hyp-job-label">${jobLabel}</span>
          <span class="status-badge ${escHtml(job.status || 'unknown')}">${escHtml(job.status || 'unknown')}</span>
          <span class="hyp-job-title">${escHtml(job.title || job.id)}</span>
          ${jCost}${jTurns}
        </div>
        <div class="detail-tabs">
          <div class="detail-tab ${tab === 'logs' ? 'active' : ''}" onclick="app.selectHypTab('logs')">Logs</div>
          <div class="detail-tab ${tab === 'assets' ? 'active' : ''}" onclick="app.selectHypTab('assets')">Assets <span style="color:var(--text-dim);font-size:10px">(${artCount})</span></div>
        </div>
        <div class="detail-body">
          <div class="detail-pane ${tab === 'logs' ? 'active' : ''}" id="hyp-pane-logs">
            <pre class="job-log" id="hyp-job-log">${logContent}</pre>
          </div>
          <div class="detail-pane ${tab === 'assets' ? 'active' : ''}" id="hyp-pane-assets">
            ${buildHypAssetsPane(job)}
          </div>
        </div>
      </div>`;
  } else {
    jobSectionHtml = `<div style="padding:12px 16px;font-size:12px;color:var(--text-dim)">No test job found for this hypothesis.</div>`;
  }

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-title" style="line-height:1.5">${escHtml(hyp.hypothesis_text)}</div>
      <div class="detail-meta" style="margin-top:8px">
        <span class="status-badge ${escHtml(hyp.status || 'proposed')}">${escHtml(hyp.status || 'proposed')}</span>
        ${conf}${type}${feat}${importanceHtml}
      </div>
      ${extraDetails ? `<div class="hyp-expand-detail" style="margin-top:10px">${extraDetails}</div>` : ''}
    </div>
    ${jobSectionHtml}`;

  if (settings.autoScroll && tab === 'logs') {
    const logEl = document.getElementById('hyp-job-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
}

// Vault toolbar listeners
document.getElementById('hyp-search').addEventListener('input', e => {
  state.hypSearch = e.target.value;
  renderHypotheses();
});
document.getElementById('hyp-sort').addEventListener('change', e => {
  state.hypSort = e.target.value;
  renderHypotheses();
});
document.getElementById('hyp-group').addEventListener('change', e => {
  state.hypGroup = e.target.value;
  renderHypotheses();
});

// ── Settings ──────────────────────────────────────────────────────────────────
function applySettingsToForm() {
  document.getElementById('s-host').value         = settings.host;
  document.getElementById('s-hyp-limit').value    = settings.hypLimit;
  document.getElementById('s-hyp-refresh').value  = settings.hypRefresh;
  document.getElementById('s-autoscroll').checked = settings.autoScroll;
  document.getElementById('s-budget-limit').value = state.serverSettings.budgetLimitUsd ?? 10;
  renderBudgetStatus();
}

function renderBudgetStatus() {
  const spent = state.serverBudget?.totalCostUsd ?? 0;
  const limit = state.serverSettings?.budgetLimitUsd ?? 10;
  const pct   = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const color = pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--yellow)' : 'var(--green)';
  const spentEl = document.getElementById('s-budget-spent');
  const barEl   = document.getElementById('s-budget-bar');
  const lblEl   = document.getElementById('s-budget-limit-label');
  if (spentEl) spentEl.textContent = `$${spent.toFixed(4)}`;
  if (barEl)   { barEl.style.width = `${pct}%`; barEl.style.background = color; }
  if (lblEl)   lblEl.textContent = `/ $${limit.toFixed(2)}`;
}

// ── App public API ─────────────────────────────────────────────────────────────
window.app = {
  selectDataset(datasetId) {
    state.selectedDatasetId = datasetId;
    renderDatasets();
    loadWiki(datasetId);
  },

  async pausePipeline() {
    await fetch(`${apiBase()}/pipeline/pause`, { method: 'POST' });
    updateAutoModeBadge(false);
  },

  async resumePipeline() {
    await fetch(`${apiBase()}/pipeline/resume`, { method: 'POST' });
    updateAutoModeBadge(true);
  },

  async triggerStage(stageId, datasetId) {
    await fetch(`${apiBase()}/pipeline/trigger/${stageId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId }),
    });
  },

  async refreshStatus() {
    try {
      const resp = await fetch(`${apiBase()}/pipeline/status`);
      const data = await resp.json();
      state.pipeline = data;
      renderPipeline();
    } catch (e) { console.warn('Refresh failed:', e); }
  },

  selectJob(jobId) {
    state.selectedJobId = jobId;
    state.selectedAssetFile = null;
    renderPipeline();
    renderJobDetail(jobId);
  },

  selectDetailTab(tab) {
    state.selectedDetailTab = tab;
    if (state.selectedJobId) renderJobDetail(state.selectedJobId);
  },

  loadAsset(jobId, filename) {
    loadAssetContent(jobId, filename);
  },

  selectHyp(id) {
    state.selectedHypId = state.selectedHypId === id ? null : id;
    state.hypDetailAsset = null;
    renderHypotheses();
    renderHypDetail();
  },

  selectHypTab(tab) {
    state.hypDetailTab = tab;
    state.hypDetailAsset = null;
    renderHypDetail();
  },

  async loadHypAsset(jobId, filename) {
    state.hypDetailAsset = filename;
    document.querySelectorAll('#hyp-pane-assets .asset-file').forEach(el => {
      el.classList.toggle('selected', el.querySelector('.asset-file-name')?.textContent === filename);
    });
    const previewArea = document.getElementById('hyp-asset-preview');
    if (!previewArea) return;
    previewArea.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-dim)"><span class="spinner"></span> Loading…</div>';
    try {
      if (isImageFile(filename)) {
        const url = `${apiBase()}/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`;
        previewArea.innerHTML = `<div class="asset-image-wrap"><img class="asset-image" src="${escAttr(url)}" alt="${escAttr(filename)}"></div>`;
        return;
      }

      const resp = await fetch(`${apiBase()}/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (filename.endsWith('.csv')) {
        previewArea.innerHTML = buildCsvTable(text);
      } else if (filename.endsWith('.json')) {
        let display = text;
        try { display = JSON.stringify(JSON.parse(text), null, 2); } catch {}
        previewArea.innerHTML = `<pre class="asset-preview">${escHtml(display.slice(0, 10000))}</pre>`;
      } else if (filename.endsWith('.md')) {
        previewArea.innerHTML = renderMarkdown(text);
      } else {
        previewArea.innerHTML = `<pre class="asset-preview">${escHtml(text.slice(0, 10000))}</pre>`;
      }
    } catch (e) {
      previewArea.innerHTML = `<div style="padding:8px;font-size:12px;color:var(--red)">Failed: ${escHtml(e.message)}</div>`;
    }
  },

  toggleGroup(key) {
    const el = document.getElementById(`grp-${key}`);
    if (el) el.classList.toggle('collapsed');
  },

  async saveSettings() {
    const prevHost = settings.host;
    settings = {
      host: document.getElementById('s-host').value.trim() || defaultSettings().host,
      hypLimit: parseInt(document.getElementById('s-hyp-limit').value) || 200,
      hypRefresh: parseInt(document.getElementById('s-hyp-refresh').value) || 30,
      autoScroll: document.getElementById('s-autoscroll').checked,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

    clearInterval(hypRefreshTimer);
    hypRefreshTimer = setInterval(loadHypotheses, settings.hypRefresh * 1000);

    if (settings.host !== prevHost) {
      if (ws) ws.close();
      clearTimeout(wsReconnectTimer);
      connectWS();
    }

    // Persist budget limit to backend
    const budgetLimitUsd = parseFloat(document.getElementById('s-budget-limit').value);
    if (!isNaN(budgetLimitUsd) && budgetLimitUsd >= 0) {
      try {
        const resp = await fetch(`${apiBase()}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ budgetLimitUsd }),
        });
        const data = await resp.json();
        if (data.settings) { state.serverSettings = data.settings; renderBudgetStatus(); }
      } catch (e) { console.warn('Failed to save backend settings:', e); }
    }

    const savedEl = document.getElementById('settings-saved');
    savedEl.style.display = 'block';
    setTimeout(() => { savedEl.style.display = 'none'; }, 2000);
  },

  async resetBudget() {
    if (!confirm('Reset budget spend counter to $0.00?')) return;
    try {
      const resp = await fetch(`${apiBase()}/budget/reset`, { method: 'POST' });
      const data = await resp.json();
      if (data.budget) { state.serverBudget = data.budget; renderBudgetStatus(); }
    } catch (e) { console.warn('Failed to reset budget:', e); }
  },
};

// ── Utilities ─────────────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);

function isImageFile(name) {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTS.has(name.slice(dot).toLowerCase());
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return `<pre class="asset-preview">${escHtml(text)}</pre>`;
  return `<div class="markdown-body">${marked.parse(text)}</div>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  applySettingsToForm();
  connectWS();

  try {
    const resp = await fetch(`${apiBase()}/pipeline/status`);
    const data = await resp.json();
    state.pipeline = data;
    renderPipeline();
  } catch { /* backend not yet up */ }

  await loadHypotheses();
  hypRefreshTimer = setInterval(loadHypotheses, settings.hypRefresh * 1000);
}

init();
