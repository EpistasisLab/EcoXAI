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
  pipeline: { autoMode: false, stages: [] },
  selectedDatasetId: null,
  selectedJobId: null,
  selectedStageId: null,
  stageDraft: null,
  availableSkills: [],
  activeJobLogs: {},
  activeView: 'datasets',
  hypSort: 'conf-desc',
  hypGroup: 'status',
  hypSearch: '',
  hypView: 'list',
  selectedHypId: null,
  hypDetailTab: 'assets',
  hypDetailAsset: null,
  selectedAssetFile: null,
  selectedDetailTab: 'assets',
  selectedSkillId: null,
  skillDraft: null,
  skillsLoaded: false,
  showNewSkillForm: false,
  serverBudget: { totalCostUsd: 0, jobCount: 0 },
  serverSettings: { budgetLimitUsd: 10, maxParallelJobs: 3 },
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
      renderHypotheses();
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
      loadHypotheses();
      break;
    }

    case 'PIPELINE_STAGE_UPDATE':
      updateStageDisplay(msg);
      if (msg.autoMode !== undefined) updateAutoModeBadge(msg.autoMode);
      break;

    case 'PIPELINE_STAGE_CONFIG_UPDATE':
      if (msg.stage) {
        const s = (state.pipeline.stages || []).find(s => s.id === msg.stage.id);
        if (s) Object.assign(s, msg.stage);
        renderPipeline();
        if (state.selectedStageId === msg.stage.id && !state.selectedJobId) renderStageDetail(msg.stage.id);
      }
      break;

    case 'DATASETS_PROMOTED':
      if (msg.datasets) state.datasets = msg.datasets;
      renderDatasets();
      if (state.selectedDatasetId) {
        const ds = state.datasets.find(d => d.id === state.selectedDatasetId);
        const input = document.getElementById('ds-context-input');
        if (input && ds) input.value = ds.userContext || '';
      }
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
  if (name === 'skills' && !state.skillsLoaded) loadSkillsList();
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
    list.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>No datasets yet.<br>Upload a CSV, JSON, Feather, or Excel file.</p></div>';
    const ctxSection = document.getElementById('ds-context-section');
    if (ctxSection) ctxSection.style.display = 'none';
    const dsBtn = document.getElementById('ds-pipeline-btn');
    if (dsBtn) dsBtn.disabled = true;
    return;
  }

  const dsBtn = document.getElementById('ds-pipeline-btn');
  if (dsBtn) dsBtn.disabled = false;

  if (!state.selectedDatasetId) {
    const ctxSection = document.getElementById('ds-context-section');
    if (ctxSection) ctxSection.style.display = 'none';
  }

  list.innerHTML = state.datasets.map(ds => {
    const pending = ds.status === 'pending';
    const conf = ds.normalization?.confidence ?? null;
    const confStr = conf !== null ? (conf * 100).toFixed(0) + '%' : '—';
    const confClass = conf !== null && conf < 0.7 ? 'ds-conf low' : 'ds-conf';
    const selected = ds.id === state.selectedDatasetId ? ' selected' : '';
    return `
      <div class="dataset-card${selected}" onclick="app.selectDataset('${ds.id}')">
        <div class="ds-name">${escHtml(ds.filename || ds.id)} <span class="ds-badge">${escHtml(ds.type || 'csv')}</span>${pending ? ' <span class="spinner" style="width:9px;height:9px;border-width:1.5px;vertical-align:middle;margin-left:4px"></span>' : ''}</div>
        <div class="ds-meta">
          <span>${(ds.recordCount || 0).toLocaleString()} rows</span>
          <span>${ds.columnCount || 0} cols</span>
          ${pending ? '<span style="color:var(--yellow)">normalizing…</span>' : `<span class="${confClass}">quality ${confStr}</span>`}
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

  const uploadArea = document.querySelector('.upload-area');
  const statusEl   = document.getElementById('upload-status');

  uploadArea.classList.add('uploading');
  statusEl.className = '';
  statusEl.textContent = '';

  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch(`${apiBase()}/upload/dataset`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    statusEl.className = 'success';
    statusEl.textContent = '✓ Uploaded — normalizing…';
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = 'Upload failed: ' + err.message;
  } finally {
    uploadArea.classList.remove('uploading');
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
    const icon = { running: '⚡', completed: '✓', failed: '✗', waiting: '⏸', retrying: '↩', idle: '○' }[status] || '○';
    const selectedStage = state.selectedStageId === stage.id ? ' selected' : '';

    const skills = Array.isArray(stage.skill) ? stage.skill : [];
    const skillPillsHtml = skills.length > 0
      ? `<div class="stage-skills">${skills.map(s => `<span class="stage-skill-pill">${escHtml(s.split(':')[1] || s)}</span>`).join('')}</div>`
      : '';

    const stageJobs = state.jobs.filter(j => j._stageId === stage.id);
    const jobsHtml = stageJobs.length === 0 ? '' : `
      <div class="stage-jobs">
        ${stageJobs.map(j => {
          const dot = JOB_STATUS_COLORS[j.status] || 'var(--text-dim)';
          const cost = j.totalCostUsd != null ? `<span class="stage-job-cost">$${j.totalCostUsd.toFixed(4)}</span>` : '';
          const turns = j.numTurns != null ? `<span class="stage-job-turns">${j.numTurns}t</span>` : '';
          const sel = state.selectedJobId === j.id ? ' selected' : '';
          return `<div class="stage-job${sel}" onclick="event.stopPropagation();app.selectJob('${j.id}')">
            <span class="stage-job-dot" style="background:${dot}"></span>
            <span class="stage-job-status">${escHtml(j.status)}</span>
            ${cost}${turns}
            <span class="stage-job-id">${escHtml(j.id)}</span>
          </div>`;
        }).join('')}
      </div>`;

    return `
      <div class="stage-item ${status}${selectedStage}" id="stage-${stage.id}" onclick="app.selectStage('${stage.id}')">
        <div class="stage-header">
          <span class="stage-icon">${icon}</span>
          <span class="stage-name">${escHtml(stage.name)}</span>
          <span class="stage-status">${status}</span>
          ${ss?.datasetId && status !== 'completed' ? `<button class="btn" style="padding:2px 8px;font-size:10px;margin-left:auto" onclick="event.stopPropagation();app.triggerStage('${stage.id}','${ss.datasetId}')">Run</button>` : ''}
        </div>
        ${skillPillsHtml}
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
  if (badge) {
    badge.textContent = autoMode ? 'AUTO' : 'PAUSED';
    badge.className = 'auto-badge ' + (autoMode ? 'on' : 'off');
  }
  const dsBadge = document.getElementById('ds-auto-badge');
  const dsMsg   = document.getElementById('ds-pipeline-msg');
  const dsBtn   = document.getElementById('ds-pipeline-btn');
  if (dsBadge) {
    dsBadge.textContent = autoMode ? 'AUTO' : 'PAUSED';
    dsBadge.className = 'auto-badge ' + (autoMode ? 'on' : 'off');
  }
  if (dsMsg) dsMsg.textContent = autoMode ? 'Pipeline is running — stages will advance automatically.' : 'Upload a dataset above, then start the pipeline.';
  if (dsBtn) {
    dsBtn.textContent = autoMode ? 'Pause Pipeline' : 'Start Pipeline';
    dsBtn.disabled = !autoMode && state.datasets.length === 0;
  }
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
      <div class="detail-tab ${state.selectedDetailTab === 'assets' ? 'active' : ''}" onclick="app.selectDetailTab('assets')">Assets <span style="color:var(--text-dim);font-size:10px">(${artCount})</span></div>
      <div class="detail-tab ${state.selectedDetailTab === 'logs' ? 'active' : ''}" onclick="app.selectDetailTab('logs')">Logs</div>
    </div>
    <div class="detail-body">
      <div class="detail-pane ${state.selectedDetailTab === 'assets' ? 'active' : ''}" id="pane-assets">
        ${buildAssetsPane(job)}
      </div>
      <div class="detail-pane ${state.selectedDetailTab === 'logs' ? 'active' : ''}" id="pane-logs">
        <pre class="job-log">${logContent}</pre>
      </div>
    </div>`;

  if (settings.autoScroll && state.selectedDetailTab === 'logs') {
    const logEl = detail.querySelector('.job-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  if (state.selectedDetailTab === 'assets' && !state.selectedAssetFile) {
    const names = (job.artifacts || []).map(a => typeof a === 'string' ? a : (a.name || a.path || ''));
    const pick = names.find(n => n === 'report.md') || names[0];
    if (pick) app.loadAsset(job.id, pick);
  }
}

function renderStageDetail(stageId) {
  const detail = document.getElementById('pipeline-detail');
  const stage = (state.pipeline.stages || []).find(s => s.id === stageId);
  if (!stage) return;

  // Preserve prompt text if user is mid-edit
  const existingTextarea = document.getElementById('stage-prompt-input');
  if (existingTextarea && state.stageDraft) state.stageDraft.prompt = existingTextarea.value;

  if (!state.stageDraft) {
    state.stageDraft = { skill: [...(stage.skill || [])], prompt: stage.prompt || '' };
  }

  const draft = state.stageDraft;
  const skillChips = draft.skill.map((s, i) =>
    `<span class="skill-chip">${escHtml(s)}<button class="skill-chip-remove" onclick="app.removeDraftSkill(${i})" title="Remove">×</button></span>`
  ).join('');

  const suggestions = (state.availableSkills || [])
    .map(s => `<option value="${escAttr(s.id)}">`)
    .join('');

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escHtml(stage.name)}</div>
      <div class="detail-meta">
        <span>trigger: ${escHtml(stage.trigger || 'manual')}</span>
        <span class="auto-badge ${stage.auto ? 'on' : 'off'}" style="margin-left:2px">${stage.auto ? 'AUTO' : 'MANUAL'}</span>
      </div>
    </div>
    <div class="stage-config-body">
      <div class="stage-config-section">
        <div class="stage-config-label">Skills</div>
        <div class="skill-chips">${skillChips || '<span style="font-size:11px;color:var(--text-dim)">No skills attached</span>'}</div>
        <div class="skill-add-row">
          <input type="text" id="skill-add-input" class="settings-input" placeholder="visibility:skill-name" style="flex:1;width:auto" list="skill-suggestions" onkeydown="if(event.key==='Enter'){event.preventDefault();app.addDraftSkill();}">
          <datalist id="skill-suggestions">${suggestions}</datalist>
          <button type="button" class="btn" onclick="app.addDraftSkill()">Add</button>
        </div>
      </div>
      <div class="stage-config-section">
        <div class="stage-config-label">Prompt</div>
        <textarea id="stage-prompt-input" class="stage-prompt-textarea">${escHtml(draft.prompt)}</textarea>
      </div>
      <div class="stage-config-actions">
        <button class="btn" onclick="app.cancelStageEdit()">Reset</button>
        <button class="btn primary" onclick="app.saveStageConfig()">Save</button>
      </div>
    </div>`;
}

function groupArtifactNames(artifacts) {
  const order = ['Markdowns', 'Scripts', 'Images', 'Other'];
  const groups = { Markdowns: [], Scripts: [], Images: [], Other: [] };
  for (const a of artifacts) {
    const name = typeof a === 'string' ? a : (a.name || a.path || 'artifact');
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (ext === 'md')                                     groups.Markdowns.push(name);
    else if (['py', 'sh', 'r', 'sql'].includes(ext))     groups.Scripts.push(name);
    else if (['png','jpg','jpeg','gif','svg'].includes(ext)) groups.Images.push(name);
    else                                                   groups.Other.push(name);
  }
  return order.filter(g => groups[g].length > 0).map(g => ({ label: g, names: groups[g] }));
}

function buildAssetsPane(job) {
  const artifacts = job.artifacts || [];
  if (artifacts.length === 0) {
    return '<div class="empty-state" style="padding:20px"><div class="icon" style="font-size:24px">📄</div><p>No assets yet.</p></div>';
  }
  const grouped = groupArtifactNames(artifacts);
  const items = grouped.map(({ label, names }) => {
    const files = names.map(name => {
      const sel = name === state.selectedAssetFile ? ' selected' : '';
      return `<div class="asset-file${sel}" onclick="app.loadAsset('${escHtml(job.id)}','${escAttr(name)}')">
        <span class="asset-file-name">${escHtml(name)}</span>
      </div>`;
    }).join('');
    return `<div class="asset-group-label">${escHtml(label)}</div>${files}`;
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

  const activeJob = state.jobs.find(j => j._hypothesisId === id && j.status === 'in-progress');

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

  const runningHtml = activeJob
    ? `<span class="hyp-running"><span class="spinner" style="width:9px;height:9px;border-width:1.5px"></span> testing</span>`
    : '';

  const hint = '';

  return `
    <div class="hyp-card${selected}" onclick="app.selectHyp(${id})">
      <div class="hyp-text">${escHtml(h.hypothesis_text)}</div>
      <div class="hyp-meta">
        <span class="status-badge ${escHtml(h.status || 'proposed')}">${escHtml(h.status || 'proposed')}</span>
        ${conf}${type}${feat}${importanceHtml}${runningHtml}
        <span style="flex:1"></span>${hint}
      </div>
    </div>`;
}

// ── Hypothesis detail panel ───────────────────────────────────────────────────

function findHypTestJob(hyp) {
  return state.jobs.find(j => j._hypothesisId === hyp.hypothesis_id) || null;
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
  const grouped = groupArtifactNames(artifacts);
  const items = grouped.map(({ label, names }) => {
    const files = names.map(name => {
      const sel = name === state.hypDetailAsset ? ' selected' : '';
      return `<div class="asset-file${sel}" onclick="app.loadHypAsset('${escHtml(job.id)}','${escAttr(name)}')">
        <span class="asset-file-name">${escHtml(name)}</span>
      </div>`;
    }).join('');
    return `<div class="asset-group-label">${escHtml(label)}</div>${files}`;
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
    panel.dataset.renderedHypId = '';
    return;
  }

  const hyp = state.hypotheses.find(h => h.hypothesis_id === state.selectedHypId);
  if (!hyp) {
    panel.innerHTML = `<div class="detail-empty"><p>Hypothesis not found</p></div>`;
    panel.dataset.renderedHypId = '';
    return;
  }

  const job = findHypTestJob(hyp);
  const tab = state.hypDetailTab;

  // Targeted update: patch in-place when same hyp/tab/job-presence is already rendered
  if (
    panel.dataset.renderedHypId == state.selectedHypId &&
    panel.dataset.renderedTab === tab &&
    panel.dataset.renderedHasJob === String(!!job)
  ) {
    const hypStatusEl = panel.querySelector('.hyp-detail-status');
    if (hypStatusEl) {
      hypStatusEl.className = `status-badge hyp-detail-status ${hyp.status || 'proposed'}`;
      hypStatusEl.textContent = hyp.status || 'proposed';
    }
    if (job) {
      const jobStatusEl = panel.querySelector('.hyp-job-status');
      if (jobStatusEl) {
        jobStatusEl.className = `status-badge hyp-job-status ${job.status || 'unknown'}`;
        jobStatusEl.textContent = job.status || 'unknown';
      }
      const costEl = panel.querySelector('.hyp-job-cost');
      if (costEl && job.totalCostUsd != null) costEl.textContent = `$${job.totalCostUsd.toFixed(4)}`;
    }
    return;
  }

  panel.dataset.renderedHypId = state.selectedHypId;
  panel.dataset.renderedTab = tab;
  panel.dataset.renderedHasJob = String(!!job);

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
    const jobLabel = job._stageId === 'analyze' ? 'Analysis Job'
      : job._stageId ? job._stageId.charAt(0).toUpperCase() + job._stageId.slice(1) + ' Job'
      : 'Job';
    const jCost = job.totalCostUsd != null ? `<span class="hyp-job-cost" style="color:var(--green)">$${job.totalCostUsd.toFixed(4)}</span>` : '';
    const jTurns = job.numTurns != null ? `<span style="color:var(--text-dim)">${job.numTurns}t</span>` : '';
    const artCount = (job.artifacts || []).length;
    const logContent = escHtml(state.activeJobLogs[job.id] || job.output || '(no output yet)');

    jobSectionHtml = `
      <div class="hyp-job-section">
        <div class="hyp-job-header">
          <span class="hyp-job-label">${jobLabel}</span>
          <span class="status-badge hyp-job-status ${escHtml(job.status || 'unknown')}">${escHtml(job.status || 'unknown')}</span>
          <span class="hyp-job-title">${escHtml(job.title || job.id)}</span>
          ${jCost}${jTurns}
        </div>
        <div class="detail-tabs">
          <div class="detail-tab ${tab === 'assets' ? 'active' : ''}" onclick="app.selectHypTab('assets')">Assets <span style="color:var(--text-dim);font-size:10px">(${artCount})</span></div>
          <div class="detail-tab ${tab === 'logs' ? 'active' : ''}" onclick="app.selectHypTab('logs')">Logs</div>
        </div>
        <div class="detail-body">
          <div class="detail-pane ${tab === 'assets' ? 'active' : ''}" id="hyp-pane-assets">
            ${buildHypAssetsPane(job)}
          </div>
          <div class="detail-pane ${tab === 'logs' ? 'active' : ''}" id="hyp-pane-logs">
            <pre class="job-log" id="hyp-job-log">${logContent}</pre>
          </div>
        </div>
      </div>`;
  } else {
    jobSectionHtml = `<div style="padding:12px 16px;font-size:12px;color:var(--text-dim)">No analysis job has run for this hypothesis yet.</div>`;
  }

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-title" style="line-height:1.5">${escHtml(hyp.hypothesis_text)}</div>
      <div class="detail-meta" style="margin-top:8px">
        <span class="status-badge hyp-detail-status ${escHtml(hyp.status || 'proposed')}">${escHtml(hyp.status || 'proposed')}</span>
        ${conf}${type}${feat}${importanceHtml}
      </div>
      ${extraDetails ? `<div class="hyp-expand-detail" style="margin-top:10px">${extraDetails}</div>` : ''}
    </div>
    ${jobSectionHtml}`;

  if (settings.autoScroll && tab === 'logs') {
    const logEl = document.getElementById('hyp-job-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  if (tab === 'assets' && job) {
    const names = (job.artifacts || []).map(a => typeof a === 'string' ? a : (a.name || a.path || ''));
    const pick = state.hypDetailAsset || names.find(n => n === 'report.md') || names[0];
    if (pick) app.loadHypAsset(job.id, pick);
  }
}

// Vault toolbar listeners
document.getElementById('hyp-search').addEventListener('input', e => {
  state.hypSearch = e.target.value;
  if (state.hypView === 'list') {
    renderHypotheses();
  } else {
    hypGraphSemanticSearch(e.target.value.trim());
  }
});
document.getElementById('hyp-sort').addEventListener('change', e => {
  state.hypSort = e.target.value;
  renderHypotheses();
});
document.getElementById('hyp-group').addEventListener('change', e => {
  state.hypGroup = e.target.value;
  renderHypotheses();
});
document.getElementById('hyp-btn-list').addEventListener('click', () => showHypView('list'));
document.getElementById('hyp-btn-graph').addEventListener('click', () => showHypView('graph'));

// ── Hypothesis Graph (native D3) ─────────────────────────────────────────────

const HYP_TYPE_COLOR = {
  genetic: '#4e79a7', metabolic: '#f28e2b', inflammatory: '#e377c2',
  lifestyle: '#59a14f', pathology: '#b07aa1', environmental: '#76b7b2',
  vascular: '#ff9da7', unknown: '#5a5a5a', other: '#9c9c9c',
};
const HYP_STATUS_COLOR = {
  supported: '#59a14f', needs_more_data: '#f28e2b', rejected: '#e15759',
  proposed: '#bab0ac', evidence_collected: '#4e79a7', evaluated: '#76b7b2',
  test_requested: '#edc948',
};

let _hypSim = null;        // active D3 simulation
let _hypNodes = [];        // current node data
let _hypHighlightIds = null; // Set of highlighted IDs, or null = all visible

function showHypView(mode) {
  state.hypView = mode;
  document.getElementById('hyp-split').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('hyp-graph-pane').style.display = mode === 'graph' ? 'flex' : 'none';
  document.getElementById('hyp-btn-list').classList.toggle('active', mode === 'list');
  document.getElementById('hyp-btn-graph').classList.toggle('active', mode === 'graph');
  // Sort/group controls only meaningful in list mode
  document.getElementById('hyp-sort').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('hyp-group').style.display = mode === 'list' ? '' : 'none';
  if (mode === 'graph') renderHypGraph();
}

async function renderHypGraph() {
  const statusEl = document.getElementById('hyp-graph-status');
  statusEl.textContent = 'Loading graph…';

  let nodes, links;
  try {
    const data = await fetch(`${apiBase()}/hypotheses/graph`).then(r => r.json());
    nodes = data.nodes || [];
    links = data.links || [];
  } catch (e) {
    statusEl.textContent = 'Failed to load graph: ' + e.message;
    return;
  }

  const embeddedCount = nodes.filter(n => n.hasEmbedding).length;
  statusEl.textContent = `${nodes.length} hypotheses · ${links.length} semantic links · ${embeddedCount} embedded`;

  _hypNodes = nodes;
  _hypHighlightIds = null;

  const svg = d3.select('#hyp-graph');
  svg.selectAll('*').remove();
  if (_hypSim) { _hypSim.stop(); _hypSim = null; }

  const el = document.getElementById('hyp-graph');
  const w = el.clientWidth || 900;
  const h = el.clientHeight || 600;

  const nodesCopy = nodes.map(d => ({ ...d }));
  const linksCopy = links.map(d => ({ ...d }));

  const tooltip = d3.select('#hyp-graph-tooltip');
  const detailPane = document.getElementById('hyp-graph-detail');

  // Glow filter
  const defs = svg.append('defs');
  const glow = defs.append('filter').attr('id', 'hyp-glow')
    .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
  glow.append('feGaussianBlur').attr('stdDeviation', '2.5').attr('result', 'b');
  const merge = glow.append('feMerge');
  merge.append('feMergeNode').attr('in', 'b');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  const root = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.15, 4]).on('zoom', e => root.attr('transform', e.transform)));

  const maxStrength = links.length ? Math.max(...links.map(l => l.strength ?? 0), 0.01) : 1;

  const link = root.append('g').selectAll('path').data(linksCopy).join('path')
    .attr('class', 'hyp-link')
    .attr('stroke', '#4e79a7')
    .attr('stroke-width', d => 0.8 + 3 * ((d.strength ?? 0) / maxStrength));

  const node = root.append('g').selectAll('g').data(nodesCopy).join('g')
    .attr('class', 'hyp-node')
    .call(hypDrag());

  const circle = node.append('circle')
    .attr('r', d => hypNodeRadius(d))
    .attr('fill', d => HYP_TYPE_COLOR[d.category] ?? HYP_TYPE_COLOR.other)
    .attr('stroke', d => HYP_STATUS_COLOR[d.status] ?? '#555')
    .attr('stroke-width', 2)
    .attr('filter', 'url(#hyp-glow)')
    .on('mouseover', (e, d) => {
      tooltip.html(hypNodeTip(d))
        .style('opacity', 1)
        .style('left', (e.pageX + 12) + 'px')
        .style('top', (e.pageY + 12) + 'px');
    })
    .on('mousemove', e => {
      tooltip.style('left', (e.pageX + 12) + 'px').style('top', (e.pageY + 12) + 'px');
    })
    .on('mouseout', () => tooltip.style('opacity', 0))
    .on('click', (e, d) => hypNodeClick(d, circle, link));

  node.append('text')
    .attr('x', d => hypNodeRadius(d) + 3)
    .attr('y', 4)
    .text(d => d.label.slice(0, 28))
    .style('display', 'none'); // shown on zoom via updateLabels

  function updateLabels(k) {
    node.select('text').style('display', k > 1.4 ? null : 'none');
  }
  svg.on('zoom.labels', e => updateLabels(e.transform.k));

  _hypSim = d3.forceSimulation(nodesCopy)
    .force('link', d3.forceLink(linksCopy).id(d => d.id).distance(d => 80 + (1 - (d.strength ?? 0)) * 80))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide(d => hypNodeRadius(d) + 4))
    .on('tick', () => {
      link.attr('d', d => {
        const x1 = d.source.x, y1 = d.source.y, x2 = d.target.x, y2 = d.target.y;
        const dr = Math.hypot(x2 - x1, y2 - y1) * 1.5;
        return `M${x1},${y1}A${dr},${dr} 0 0,1 ${x2},${y2}`;
      });
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
}

function hypNodeRadius(d) {
  return 5 + (d.confidence != null ? d.confidence : 0.4) * 10;
}

function hypNodeTip(d) {
  const sc = HYP_STATUS_COLOR[d.status] ?? '#bab0ac';
  const conf = d.confidence != null ? (d.confidence * 100).toFixed(0) + '%' : 'n/a';
  const emb = d.hasEmbedding ? '' : ' <span style="color:#888">(no embedding)</span>';
  return `<b style="color:#e8edf3">${escHtml(d.label)}</b>${emb}<br>` +
    `type: <b>${escHtml(d.category)}</b><br>` +
    `<span style="color:${sc}">● ${(d.status || '').replace(/_/g, ' ')}</span><br>` +
    `confidence: ${conf}` +
    (d.feature_name ? `<br>feature: ${escHtml(d.feature_name)}` : '');
}

async function hypNodeClick(d, circleSelection, linkSelection) {
  if (!d.hasEmbedding) {
    document.getElementById('hyp-graph-detail').style.display = 'none';
    return;
  }

  // Extract numeric ID from "h-42"
  const numId = parseInt(d.id.replace('h-', ''));

  // Fetch neighbors
  let neighbors = [];
  try {
    const resp = await fetch(`${apiBase()}/hypotheses/${numId}/similar?k=8`);
    const data = await resp.json();
    neighbors = (data.hypotheses || []).map(h => `h-${h.hypothesis_id}`);
  } catch (_) {}

  const neighborSet = new Set([d.id, ...neighbors]);
  _hypHighlightIds = neighborSet;

  // Dim non-neighbors
  circleSelection.style('opacity', n => neighborSet.has(n.id) ? 1 : 0.12);
  linkSelection.style('stroke-opacity', l => {
    const src = l.source.id ?? l.source;
    const tgt = l.target.id ?? l.target;
    return (neighborSet.has(src) && neighborSet.has(tgt)) ? 0.8 : 0.04;
  });

  // Show detail panel with hypothesis info + neighbors
  const hyp = state.hypotheses.find(h => h.hypothesis_id === numId);
  const detail = document.getElementById('hyp-graph-detail');
  detail.style.display = 'block';
  const sc = HYP_STATUS_COLOR[d.status] ?? '#bab0ac';
  detail.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
      <span style="font-size:11px;color:${sc}">● ${(d.status || '').replace(/_/g, ' ')}</span>
      <button onclick="this.closest('#hyp-graph-detail').style.display='none';_hypHighlightIds=null;document.querySelectorAll('#hyp-graph .hyp-node circle').forEach(c=>c.style.opacity='');document.querySelectorAll('#hyp-graph .hyp-link').forEach(l=>l.style.strokeOpacity='');"
        style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0;line-height:1">✕</button>
    </div>
    <div style="font-size:12px;color:#e8edf3;line-height:1.5;margin-bottom:10px">${escHtml(d.label)}${d.label.length >= 80 ? '…' : ''}</div>
    <div style="font-size:11px;color:#5a6070;margin-bottom:4px">type: ${escHtml(d.category)}${d.feature_name ? ' · ' + escHtml(d.feature_name) : ''}</div>
    ${neighbors.length ? `<div style="margin-top:10px;font-size:11px;color:#5a6070;border-top:1px solid #2a3040;padding-top:8px">Semantic neighbors (${neighbors.length})</div>` : ''}
  `;
}

let _hypSearchTimer = null;
function hypGraphSemanticSearch(q) {
  clearTimeout(_hypSearchTimer);
  if (!q) {
    // Reset highlight
    _hypHighlightIds = null;
    d3.selectAll('#hyp-graph .hyp-node circle').style('opacity', null);
    d3.selectAll('#hyp-graph .hyp-link').style('stroke-opacity', null);
    return;
  }
  _hypSearchTimer = setTimeout(async () => {
    try {
      const resp = await fetch(`${apiBase()}/hypotheses/similar?q=${encodeURIComponent(q)}&k=15`);
      const data = await resp.json();
      const matchIds = new Set((data.hypotheses || []).map(h => `h-${h.hypothesis_id}`));
      _hypHighlightIds = matchIds;
      d3.selectAll('#hyp-graph .hyp-node circle')
        .style('opacity', d => matchIds.has(d.id) ? 1 : 0.12);
      d3.selectAll('#hyp-graph .hyp-link')
        .style('stroke-opacity', l => {
          const src = l.source.id ?? l.source;
          const tgt = l.target.id ?? l.target;
          return matchIds.has(src) || matchIds.has(tgt) ? 0.6 : 0.04;
        });
    } catch (_) {}
  }, 350);
}

function hypDrag() {
  return d3.drag()
    .on('start', (e, d) => { if (!e.active) _hypSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) _hypSim.alphaTarget(0); d.fx = null; d.fy = null; });
}

// ── Skills view ───────────────────────────────────────────────────────────────
async function loadSkillsList() {
  try {
    const resp = await fetch(`${apiBase()}/pipeline/skills`);
    const data = await resp.json();
    state.availableSkills = data.skills || [];
    state.skillsLoaded = true;
    renderSkillsList();
  } catch (e) { console.warn('Failed to load skills:', e); }
}

function renderSkillsList() {
  const list = document.getElementById('skill-list');
  if (!list) return;
  const skills = state.availableSkills;

  const countEl = document.getElementById('skills-count');
  if (countEl) countEl.textContent = skills.length;

  const newSkillFormHtml = state.showNewSkillForm ? `
    <div style="padding:8px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--border)">
      <select id="new-skill-vis" class="settings-input" style="width:100%">
        <option value="public">public</option>
        <option value="hypotheses">hypotheses</option>
      </select>
      <input id="new-skill-name" class="settings-input" style="width:100%;box-sizing:border-box"
             placeholder="skill-name (e.g. pipeline-test)">
      <div style="display:flex;gap:6px">
        <button class="btn primary" style="flex:1" onclick="app.createSkill()">Create</button>
        <button class="btn" onclick="app.hideNewSkillForm()">Cancel</button>
      </div>
      <div id="new-skill-error" style="font-size:11px;color:var(--red);min-height:14px"></div>
    </div>` : '';

  if (skills.length === 0) {
    list.innerHTML = `<div style="padding:8px"><button class="btn primary" style="width:100%" onclick="app.showNewSkillForm()">+ New Skill</button></div>
      ${newSkillFormHtml}
      <div class="empty-state" style="padding:24px"><div class="icon" style="font-size:24px">🛠</div><p>No skills found.</p></div>`;
    return;
  }

  const groups = {};
  for (const s of skills) {
    (groups[s.visibility] = groups[s.visibility] || []).push(s);
  }

  list.innerHTML = `<div style="padding:8px"><button class="btn primary" style="width:100%" onclick="app.showNewSkillForm()">+ New Skill</button></div>
    ${newSkillFormHtml}` + Object.keys(groups).sort().map(vis => `
    <div class="skill-group">
      <div class="skill-group-header">${escHtml(vis)}</div>
      ${groups[vis].map(s => {
        const sel = state.selectedSkillId === s.id ? ' selected' : '';
        return `<div class="stage-item${sel}" onclick="app.selectSkill('${escAttr(s.id)}')">
          <div class="stage-header">
            <span class="stage-icon">📄</span>
            <span class="stage-name">${escHtml(s.name)}</span>
          </div>
        </div>`;
      }).join('')}
    </div>`).join('');
}

function renderSkillDetail(skillId) {
  const detail = document.getElementById('skill-detail');
  const skill = (state.availableSkills || []).find(s => s.id === skillId);
  if (!skill || !detail) return;

  const content = state.skillDraft !== null ? state.skillDraft : '(loading…)';

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escHtml(skill.name)}</div>
      <div class="detail-meta"><span style="color:var(--text-dim)">${escHtml(skill.visibility)}</span></div>
    </div>
    <div class="stage-config-body">
      <div class="stage-config-section" style="flex:1;display:flex;flex-direction:column">
        <div class="stage-config-label">SKILL.md</div>
        <textarea id="skill-content-input" class="stage-prompt-textarea" style="flex:1;min-height:400px;font-family:monospace;font-size:12px">${escHtml(content)}</textarea>
      </div>
      <div class="stage-config-actions">
        <button class="btn" onclick="app.cancelSkillEdit()">Reset</button>
        <button class="btn primary" onclick="app.saveSkillContent()">Save</button>
      </div>
    </div>`;
}

// ── Settings ──────────────────────────────────────────────────────────────────
function applySettingsToForm() {
  document.getElementById('s-host').value         = settings.host;
  document.getElementById('s-hyp-limit').value    = settings.hypLimit;
  document.getElementById('s-hyp-refresh').value  = settings.hypRefresh;
  document.getElementById('s-autoscroll').checked = settings.autoScroll;
  document.getElementById('s-max-parallel-jobs').value = state.serverSettings.maxParallelJobs ?? 3;
  document.getElementById('s-max-hypothesis-cycles').value = state.serverSettings.maxHypothesisCycles ?? 2;
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
    const section = document.getElementById('ds-context-section');
    const input   = document.getElementById('ds-context-input');
    if (section && input) {
      const ds = state.datasets.find(d => d.id === datasetId);
      input.value = ds?.userContext || '';
      section.style.display = 'block';
    }
  },

  async pausePipeline() {
    await fetch(`${apiBase()}/pipeline/pause`, { method: 'POST' });
    state.pipeline.autoMode = false;
    updateAutoModeBadge(false);
  },

  async resumePipeline() {
    await fetch(`${apiBase()}/pipeline/resume`, { method: 'POST' });
    state.pipeline.autoMode = true;
    updateAutoModeBadge(true);
  },

  async togglePipeline() {
    if (state.pipeline.autoMode) {
      await this.pausePipeline();
    } else {
      await this.resumePipeline();
    }
  },

  async saveDatasetContext() {
    if (!state.selectedDatasetId) return;
    const text = (document.getElementById('ds-context-input')?.value || '').trim();
    await fetch(`${apiBase()}/datasets/${state.selectedDatasetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userContext: text }),
    });
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
    state.selectedStageId = null;
    state.stageDraft = null;
    state.selectedAssetFile = null;
    renderPipeline();
    renderJobDetail(jobId);
  },

  selectStage(stageId) {
    if (state.selectedStageId === stageId && !state.selectedJobId) {
      state.selectedStageId = null;
      state.stageDraft = null;
      document.getElementById('pipeline-detail').innerHTML = `<div class="detail-empty"><div style="font-size:32px;margin-bottom:8px">⚡</div><p>Select a job or stage to view details</p></div>`;
      renderPipeline();
      return;
    }
    state.selectedStageId = stageId;
    state.selectedJobId = null;
    state.stageDraft = null;
    state.selectedAssetFile = null;
    renderPipeline();
    renderStageDetail(stageId);
    if (!state.availableSkills.length) {
      fetch(`${apiBase()}/pipeline/skills`)
        .then(r => r.json())
        .then(d => { state.availableSkills = d.skills || []; renderStageDetail(stageId); })
        .catch(() => {});
    }
  },

  removeDraftSkill(idx) {
    const stage = (state.pipeline.stages || []).find(s => s.id === state.selectedStageId);
    if (!stage) return;
    if (!state.stageDraft) state.stageDraft = { skill: [...(stage.skill || [])], prompt: stage.prompt || '' };
    state.stageDraft.skill.splice(idx, 1);
    renderStageDetail(state.selectedStageId);
    app.saveStageConfig();
  },

  addDraftSkill() {
    const input = document.getElementById('skill-add-input');
    const val = input?.value.trim();
    if (!val) return;
    if (!val.includes(':')) {
      input.setCustomValidity('Format must be visibility:skill-name (e.g. public:pipeline-explore)');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    const stage = (state.pipeline.stages || []).find(s => s.id === state.selectedStageId);
    if (!stage) return;
    if (!state.stageDraft) state.stageDraft = { skill: [...(stage.skill || [])], prompt: stage.prompt || '' };
    if (!state.stageDraft.skill.includes(val)) state.stageDraft.skill.push(val);
    if (input) input.value = '';
    renderStageDetail(state.selectedStageId);
    app.saveStageConfig();
  },

  cancelStageEdit() {
    state.stageDraft = null;
    if (state.selectedStageId) renderStageDetail(state.selectedStageId);
  },

  async saveStageConfig() {
    const stageId = state.selectedStageId;
    if (!stageId) return;
    const stage = (state.pipeline.stages || []).find(s => s.id === stageId);
    if (!stage) return;

    const skill = state.stageDraft?.skill ?? stage.skill ?? [];
    const prompt = document.getElementById('stage-prompt-input')?.value ?? stage.prompt ?? '';

    try {
      const resp = await fetch(`${apiBase()}/pipeline/stages/${stageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill, prompt }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      if (data.stage) Object.assign(stage, data.stage);
      state.stageDraft = null;
      renderPipeline();
      renderStageDetail(stageId);
      const detail = document.getElementById('pipeline-detail');
      const savedMsg = document.createElement('div');
      savedMsg.style.cssText = 'padding:6px 16px;font-size:12px;color:var(--green)';
      savedMsg.textContent = '✓ Saved';
      detail.appendChild(savedMsg);
      setTimeout(() => savedMsg.remove(), 2000);
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
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

    // Persist settings to backend
    const budgetLimitUsd = parseFloat(document.getElementById('s-budget-limit').value);
    const maxParallelJobs = parseInt(document.getElementById('s-max-parallel-jobs').value);
    const maxHypothesisCycles = parseInt(document.getElementById('s-max-hypothesis-cycles').value);
    const backendBody = {};
    if (!isNaN(budgetLimitUsd) && budgetLimitUsd >= 0) backendBody.budgetLimitUsd = budgetLimitUsd;
    if (!isNaN(maxParallelJobs) && maxParallelJobs >= 1) backendBody.maxParallelJobs = maxParallelJobs;
    if (!isNaN(maxHypothesisCycles) && maxHypothesisCycles >= 0) backendBody.maxHypothesisCycles = maxHypothesisCycles;
    if (Object.keys(backendBody).length) {
      try {
        const resp = await fetch(`${apiBase()}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backendBody),
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

  showNewSkillForm() {
    state.showNewSkillForm = true;
    renderSkillsList();
    document.getElementById('new-skill-name')?.focus();
  },

  hideNewSkillForm() {
    state.showNewSkillForm = false;
    renderSkillsList();
  },

  async createSkill() {
    const vis = document.getElementById('new-skill-vis')?.value ?? 'public';
    const name = (document.getElementById('new-skill-name')?.value ?? '').trim();
    const errEl = document.getElementById('new-skill-error');
    if (!name) { if (errEl) errEl.textContent = 'Name is required.'; return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      if (errEl) errEl.textContent = 'Only letters, numbers, hyphens, and underscores allowed.';
      return;
    }
    if (errEl) errEl.textContent = '';
    try {
      const resp = await fetch(`${apiBase()}/pipeline/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: vis, name }),
      });
      const data = await resp.json();
      if (!data.success) { if (errEl) errEl.textContent = data.error || 'Failed to create skill.'; return; }
      state.showNewSkillForm = false;
      state.skillsLoaded = false;
      await loadSkillsList();
      app.selectSkill(data.skill.id);
    } catch (e) {
      if (errEl) errEl.textContent = 'Request failed: ' + e.message;
    }
  },

  async selectSkill(skillId) {
    if (state.selectedSkillId === skillId) return;
    state.selectedSkillId = skillId;
    state.skillDraft = null;
    renderSkillsList();

    const skill = (state.availableSkills || []).find(s => s.id === skillId);
    if (!skill) return;

    renderSkillDetail(skillId);

    try {
      const resp = await fetch(`${apiBase()}/pipeline/skills/${encodeURIComponent(skill.visibility)}/${encodeURIComponent(skill.name)}/content`);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      state.skillDraft = data.content;
      renderSkillDetail(skillId);
    } catch (e) {
      state.skillDraft = `// Failed to load: ${e.message}`;
      renderSkillDetail(skillId);
    }
  },

  async cancelSkillEdit() {
    const skillId = state.selectedSkillId;
    if (!skillId) return;
    state.skillDraft = null;
    const skill = (state.availableSkills || []).find(s => s.id === skillId);
    if (!skill) return;
    renderSkillDetail(skillId);
    try {
      const resp = await fetch(`${apiBase()}/pipeline/skills/${encodeURIComponent(skill.visibility)}/${encodeURIComponent(skill.name)}/content`);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      state.skillDraft = data.content;
      renderSkillDetail(skillId);
    } catch (e) {
      state.skillDraft = `// Failed to load: ${e.message}`;
      renderSkillDetail(skillId);
    }
  },

  async saveSkillContent() {
    const skillId = state.selectedSkillId;
    if (!skillId) return;
    const skill = (state.availableSkills || []).find(s => s.id === skillId);
    if (!skill) return;

    const content = document.getElementById('skill-content-input')?.value ?? '';

    try {
      const resp = await fetch(`${apiBase()}/pipeline/skills/${encodeURIComponent(skill.visibility)}/${encodeURIComponent(skill.name)}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);
      state.skillDraft = content;
      const detail = document.getElementById('skill-detail');
      const savedMsg = document.createElement('div');
      savedMsg.style.cssText = 'padding:6px 16px;font-size:12px;color:var(--green)';
      savedMsg.textContent = '✓ Saved';
      detail.appendChild(savedMsg);
      setTimeout(() => savedMsg.remove(), 2000);
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
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
