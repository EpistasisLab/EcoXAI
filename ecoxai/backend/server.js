require('dotenv').config();

const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const MAX_FEATHER_BYTES = parseInt(process.env.MAX_FEATHER_BYTES, 10) || 2 * 1024 * 1024 * 1024;
const MAX_FEATHER_ROWS  = parseInt(process.env.MAX_FEATHER_ROWS,  10) || 5_000_000;
const http = require('http');
const path = require('path');
const fs = require('fs');
const arrow = require('apache-arrow');

const containerManager = require('./services/containerManager');
const volumeManager = require('./services/volumeManager');
const dbManager = require('./services/databaseManager');
const normalizationService = require('./services/normalizationService');
const embeddingService = require('./services/embeddingService');
const orchestrator = require('./orchestrator');
const jobExecution = require('./services/jobExecution');

const createDatasetsRoutes = require('./routes/datasets');
const createJobsRoutes = require('./routes/jobs');
const createHypothesesRoutes = require('./routes/hypotheses');
const createPipelineRoutes = require('./routes/pipeline');

// ── Error handling ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  if (err.code === 'EOF' || err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.warn('[uncaughtException] Stream error suppressed:', err.message);
    return;
  }
  console.error('[uncaughtException] Fatal:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', reason); });

// ── Express + WebSocket ────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Serve frontend from lean/frontend
const frontendPath = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FEATHER_BYTES },
});

// ── State ─────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save state:', error.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const loaded = JSON.parse(data);
      if (loaded.jobs) {
        loaded.jobs = loaded.jobs.map(j => ({ ...j, selectedSkills: j.selectedSkills || [], skillsInvoked: j.skillsInvoked || [] }));
      }
      loaded.budget = loaded.budget || { totalCostUsd: 0, jobCount: 0 };
      loaded.settings = loaded.settings || { budgetLimitUsd: 10, maxParallelJobs: 3, maxHypothesisCycles: 2, containerRamMb: 12288 };
      if (loaded.settings.maxParallelJobs === undefined) loaded.settings.maxParallelJobs = 3;
      if (loaded.settings.maxHypothesisCycles === undefined) loaded.settings.maxHypothesisCycles = 2;
      if (loaded.settings.containerRamMb === undefined) loaded.settings.containerRamMb = 12288;
      console.log(`Loaded state: ${loaded.jobs?.length || 0} jobs, ${Object.keys(loaded.datasets || {}).length} datasets`);
      return loaded;
    }
  } catch (error) {
    console.error('Failed to load state:', error.message);
  }
  return { jobs: [], datasets: {}, budget: { totalCostUsd: 0, jobCount: 0 }, settings: { budgetLimitUsd: 10, maxParallelJobs: 3, maxHypothesisCycles: 2, containerRamMb: 12288 } };
}

let state = loadState();

// ── WebSocket ────────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'FULL_STATE',
    jobs: state.jobs,
    datasets: Object.values(state.datasets),
    pipeline: orchestrator.getStatus(),
    budget: state.budget || { totalCostUsd: 0, jobCount: 0 },
    settings: state.settings || { budgetLimitUsd: 10, maxParallelJobs: 3, maxHypothesisCycles: 2 },
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', (err) => { console.warn('[WS] Client error:', err.message); clients.delete(ws); });
});

// ── Parsers ───────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV must have header and at least one row');
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function parseJSON(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('JSON must be an array');
  return data;
}

async function parseFeather(buffer) {
  // First try the pure-JS path (works for uncompressed feather)
  try {
    const table = arrow.tableFromIPC(buffer);
    const rows = [];
    for (let i = 0; i < table.numRows; i++) {
      const row = {};
      table.schema.fields.forEach(field => { row[field.name] = table.getChild(field.name).get(i); });
      rows.push(row);
    }
    return rows;
  } catch (jsErr) {
    // Fall back to Python/pyarrow for compressed feather files
    if (!jsErr.message.includes('codec')) throw new Error(`Failed to parse Feather file: ${jsErr.message}`);
    return parseFeatherViaPython(buffer);
  }
}

async function parseFeatherViaPython(buffer) {
  const { execFile } = require('child_process');
  const os = require('os');
  const tmpFeather = path.join(os.tmpdir(), `ecoxai_feather_${Date.now()}.feather`);
  fs.writeFileSync(tmpFeather, buffer);
  return new Promise((resolve, reject) => {
    // Only extract shape metadata (num_rows + column names) — avoids deserializing all values
    const script = `
import sys, json
try:
    import pyarrow.feather as feather
    t = feather.read_table(sys.argv[1])
    print(json.dumps({"num_rows": t.num_rows, "columns": t.schema.names}))
except ImportError:
    print(json.dumps({"__error__": "pyarrow not installed"}))
`;
    execFile('python', ['-c', script, tmpFeather], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFeather); } catch (_) {}
      if (err) return reject(new Error(`Failed to parse Feather file via Python: ${err.message}\n${stderr}`));
      let meta;
      try { meta = JSON.parse(stdout.trim()); } catch (e) {
        return reject(new Error(`Failed to parse Feather file: unexpected Python output — ${e.message}`));
      }
      if (meta.__error__) return reject(new Error(`Failed to parse Feather file: ${meta.__error__}`));
      // Build a lightweight stub: one header row with null values, length = num_rows
      // Callers only need parsedData.length and Object.keys(parsedData[0])
      const headerRow = {};
      meta.columns.forEach(c => { headerRow[c] = null; });
      const stub = new Array(meta.num_rows).fill(headerRow);
      resolve(stub);
    });
  });
}

function parseWorkbook(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
}

// ── Job helpers ───────────────────────────────────────────────────────────────
function findJob(jobId) { return state.jobs.find(j => j.id === jobId); }

function updateJob(jobId, updates) {
  const index = state.jobs.findIndex(j => j.id === jobId);
  if (index !== -1) state.jobs[index] = { ...state.jobs[index], ...updates };
  saveState();
  return state.jobs[index] || null;
}

function createJobFromData(data, index) {
  return {
    id: data.id || `J${Date.now()}_${index}`,
    title: data.title || `Uploaded Job ${index + 1}`,
    status: 'todo',
    prompt: data.prompt || '',
    datasetId: data.datasetId || null,
    selectedSkills: [],
    skillsInvoked: [],
    output: '',
    artifacts: [],
    exitCode: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString()
  };
}

// ── Route dependencies ────────────────────────────────────────────────────────
const routeDeps = {
  state,
  saveState,
  broadcast,
  findJob,
  updateJob,
  createJobFromData,
  parseCSV,
  parseJSON,
  parseFeather,
  parseWorkbook,
  containerManager,
  volumeManager,
  dbManager,
  normalizationService,
  upload,
  orchestrator,
  MAX_FEATHER_BYTES,
  MAX_FEATHER_ROWS,
};

routeDeps.startJobExecution = (jobId, opts) =>
  jobExecution.startJobExecution({ ...routeDeps, orchestrator }, jobId, opts);

// ── Initialize orchestrator ───────────────────────────────────────────────────
orchestrator.init({
  state,
  saveState,
  broadcast,
  findJob,
  updateJob,
  startJobExecution: routeDeps.startJobExecution,
  dbManager,
  volumeManager,
  normalizationService,
});

// ── Mount routes ──────────────────────────────────────────────────────────────
app.use('/api', createDatasetsRoutes(routeDeps));
app.use('/api', createJobsRoutes(routeDeps));
app.use('/api', createHypothesesRoutes(routeDeps));
app.use('/api', createPipelineRoutes({ orchestrator }));

// Health check
app.get('/api/health', async (req, res) => {
  const docker = await containerManager.healthCheck();
  res.json({ success: true, port: PORT, docker, uptime: process.uptime() });
});

// Budget
app.get('/api/budget', (req, res) => {
  res.json({ success: true, budget: state.budget || { totalCostUsd: 0, jobCount: 0 } });
});

app.post('/api/budget/reset', (req, res) => {
  state.budget = { totalCostUsd: 0, jobCount: 0 };
  saveState();
  broadcast({ type: 'BUDGET_UPDATE', budget: state.budget });
  res.json({ success: true, budget: state.budget });
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: state.settings || { budgetLimitUsd: 10 } });
});

app.put('/api/settings', (req, res) => {
  if (!state.settings) state.settings = { budgetLimitUsd: 10, maxParallelJobs: 3, maxHypothesisCycles: 2, containerRamMb: 12288 };
  const { budgetLimitUsd, maxParallelJobs, maxHypothesisCycles, containerRamMb } = req.body;
  if (budgetLimitUsd !== undefined) {
    const limit = parseFloat(budgetLimitUsd);
    if (isNaN(limit) || limit < 0) return res.status(400).json({ success: false, error: 'budgetLimitUsd must be a non-negative number' });
    state.settings.budgetLimitUsd = limit;
  }
  if (maxParallelJobs !== undefined) {
    const limit = parseInt(maxParallelJobs);
    if (isNaN(limit) || limit < 1) return res.status(400).json({ success: false, error: 'maxParallelJobs must be a positive integer' });
    state.settings.maxParallelJobs = limit;
  }
  if (maxHypothesisCycles !== undefined) {
    const val = parseInt(maxHypothesisCycles, 10);
    if (isNaN(val) || val < 0) return res.status(400).json({ success: false, error: 'maxHypothesisCycles must be a non-negative integer' });
    state.settings.maxHypothesisCycles = val;
  }
  if (containerRamMb !== undefined) {
    const mb = parseInt(containerRamMb, 10);
    if (isNaN(mb) || mb < 256 || mb > 65536) return res.status(400).json({ success: false, error: 'containerRamMb must be between 256 and 65536' });
    state.settings.containerRamMb = mb;
  }
  saveState();
  broadcast({ type: 'SETTINGS_UPDATE', settings: state.settings });
  res.json({ success: true, settings: state.settings });
});

// ── Stale job reconciliation ──────────────────────────────────────────────────
async function reconcileStaleJobs() {
  const staleJobs = state.jobs.filter(j => j.status === 'in-progress');
  for (const job of staleJobs) {
    await updateJob(job.id, { status: 'failed', exitCode: -1, completedAt: new Date().toISOString() });
    console.log(`  Marked stale job ${job.id} as failed`);
  }
  if (staleJobs.length) saveState();
}

// ── Dataset drop-in watcher ───────────────────────────────────────────────────
function watchDatasetFolder() {
  const datasetsDir = path.join(__dirname, 'datasets');
  if (!fs.existsSync(datasetsDir)) {
    fs.mkdirSync(datasetsDir, { recursive: true });
  }

  try {
    const chokidar = require('chokidar');
    const watcher = chokidar.watch(datasetsDir, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
    });

    watcher.on('add', async (filePath) => {
      const filename = path.basename(filePath);
      const ext = path.extname(filename).toLowerCase();
      if (!['.csv', '.json', '.feather', '.xlsx', '.xls'].includes(ext)) return;

      const alreadyIngested = Object.values(state.datasets).some(d => d.filename === filename);
      if (alreadyIngested) {
        console.log(`[Watcher] Skipping ${filename} — already in state`);
        return;
      }

      console.log(`[Watcher] New dataset file detected: ${filename}`);

      try {
        if (ext === '.feather') {
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_FEATHER_BYTES) {
            console.error(`[Watcher] Rejected ${filename}: ${stat.size} bytes exceeds ${MAX_FEATHER_BYTES} byte limit`);
            return;
          }
        }

        const buffer = fs.readFileSync(filePath);
        const datasetId = `dataset_${Date.now()}`;
        let parsedData;
        let fileType;

        if (ext === '.csv') {
          parsedData = parseCSV(buffer.toString('utf-8'));
          fileType = 'csv';
        } else if (ext === '.json') {
          parsedData = parseJSON(buffer.toString('utf-8'));
          fileType = 'json';
        } else if (ext === '.xlsx' || ext === '.xls') {
          parsedData = parseWorkbook(buffer);
          fileType = 'xlsx';
        } else {
          parsedData = await parseFeather(buffer);
          fileType = 'feather';
        }

        // Store as pending — normalization runs when the user starts the pipeline
        const columnCount = parsedData.length > 0 ? Object.keys(parsedData[0]).length : 0;
        state.datasets[datasetId] = {
          id: datasetId, filename, sanitizedFilename: datasetId,
          size: buffer.length,
          uploadedAt: new Date().toISOString(), type: fileType,
          recordCount: parsedData.length, columnCount,
          status: 'pending',
          _pendingFilePath: filePath,
        };
        saveState();
        broadcast({ type: 'DATASETS_PROMOTED', datasets: Object.values(state.datasets) });

        console.log(`[Watcher] ✓ ${filename} → ${datasetId} (${parsedData.length} records) — awaiting pipeline start`);

      } catch (err) {
        console.error(`[Watcher] Failed to process ${filename}:`, err.message);
      }
    });

    console.log(`[Watcher] Watching ${datasetsDir} for CSV/JSON/Feather/Excel files`);
  } catch (err) {
    console.warn('[Watcher] chokidar not available, file-drop watching disabled:', err.message);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.LEAN_PORT || 8081;

async function start() {
  // Ensure data dir exists
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Initialize normalization service
  await normalizationService.initialize().catch(err => console.warn('[Normalization] Init warning:', err.message));

  // Initialize Docker volumes
  await volumeManager.initializeDatasetVolume().catch(err => console.warn('[Volume] Init warning:', err.message));

  // Initialize database (optional — graceful degradation)
  try {
    await dbManager.initialize();
    console.log('Database initialized');
  } catch (err) {
    console.warn('[DB] Not available — observability disabled:', err.message);
  }

  // Pre-load embedding model in the background (avoids cold-start on first RAG request)
  embeddingService.warmup();

  // Reconcile stale jobs
  await reconcileStaleJobs();

  // Start file watcher
  watchDatasetFolder();

  // Start HTTP server
  server.listen(PORT, () => {
    console.log(`\nEcoXAI Lean Backend running on port ${PORT}`);
    console.log(`  REST API: http://localhost:${PORT}/api`);
    console.log(`  WebSocket: ws://localhost:${PORT}`);
    console.log(`  Frontend: http://localhost:${PORT}/`);
    console.log(`  Drop datasets in: lean/backend/datasets/`);
    console.log(`  Pipeline stages: ${['normalize', 'explore', 'hypothesize', 'test', 'validate'].join(' → ')}\n`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
