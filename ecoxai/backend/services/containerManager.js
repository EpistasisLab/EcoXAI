const Docker = require('dockerode');
const path = require('path');
const { PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
const dbManager = require('./databaseManager');

const docker = new Docker();

function formatClaudeOutput(json) {
  const { type, subtype } = json;
  let displayText = null;
  let logData = null;

  switch (type) {
    case 'system':
      if (subtype === 'init') {
        displayText = `\n━━━ Agent Session Initialized ━━━\nModel: ${json.model}\n`;
        logData = { type: 'init', model: json.model, permissionMode: json.permissionMode, sandboxId: json.sandboxId };
      }
      break;

    case 'assistant': {
      const content = json.message?.content || [];
      let output = '';
      const toolCalls = [];
      let thinking = null;
      for (const item of content) {
        if (item.type === 'text') output += `\n💭 ${item.text}\n`;
        else if (item.type === 'thinking') { output += `\n🧠 Thinking: ${item.thinking}\n`; thinking = item.thinking; }
        else if (item.type === 'tool_use') {
          output += `\n🔧 Tool: ${item.name} - Arguments: ${JSON.stringify(item.input)}\n`;
          toolCalls.push({ tool_id: item.id, tool_name: item.name, arguments: item.input });
        }
      }
      displayText = output || null;
      logData = { type: 'assistant_message', thinking, toolCalls, messageId: json.message?.id };
      break;
    }

    case 'user':
      if (json.message?.content) {
        const results = json.message.content.filter(c => c.type === 'tool_result');
        if (results.length > 0) {
          let output = '';
          const toolResults = [];
          for (const result of results) {
            const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
            output += `\n✓ Tool Result:\n${content.split('\n').map(l => '  ' + l).join('\n')}\n`;
            toolResults.push({ tool_call_id: result.tool_use_id, content: result.content, is_error: result.is_error || false });
          }
          displayText = output;
          logData = { type: 'tool_results', results: toolResults };
        }
      }
      break;

    case 'result':
      if (subtype === 'success') {
        displayText = `\n━━━ Execution Complete ━━━\nDuration: ${json.duration_ms}ms\nCost: $${json.total_cost_usd?.toFixed(4) || '0.0000'}\n\n✅ ${json.result}\n`;
        logData = { type: 'completion', duration_ms: json.duration_ms, total_cost_usd: json.total_cost_usd, num_turns: json.num_turns, result: json.result };
      } else if (subtype === 'error') {
        displayText = `\n❌ Error: ${json.error_message || 'Unknown error'}\n`;
        logData = { type: 'error', error_message: json.error_message };
      }
      break;
  }

  return { displayText, logData };
}

class ExecutionLogBuffer {
  constructor(runId) {
    this.runId = runId;
    this.steps = [];
    this.toolCalls = [];
    this.pendingToolCalls = new Map();
    this.currentTurn = 0;
    this.currentStep = 0;
    this.model = null;
    this.sandboxId = null;
    this.permissionMode = null;
    this.completionData = null;
    this.errorMessage = null;
  }

  addInitData(data) { this.model = data.model; this.sandboxId = data.sandboxId; this.permissionMode = data.permissionMode; }

  addAssistantMessage(data, timestamp = new Date().toISOString()) {
    this.currentTurn++;
    if (data.thinking) {
      this.steps.push({ run_id: this.runId, step_number: this.currentStep++, step_type: 'thinking', input: null, output: data.thinking, started_at: timestamp, completed_at: timestamp, duration_ms: 0, success: 1 });
    }
    const toolCallsSummary = data.toolCalls.map(tc => tc.tool_name).join(', ');
    this.steps.push({ run_id: this.runId, step_number: this.currentStep++, step_type: 'turn', input: data.thinking || null, output: toolCallsSummary || 'No tool calls', started_at: timestamp, completed_at: timestamp, duration_ms: 0, success: 1, metadata_json: JSON.stringify({ turn_number: this.currentTurn, message_id: data.messageId }) });
    for (const toolCall of data.toolCalls) {
      this.pendingToolCalls.set(toolCall.tool_id, { tool_name: toolCall.tool_name, arguments: toolCall.arguments, turn_number: this.currentTurn, started_at: timestamp });
    }
  }

  addToolResults(results, timestamp = new Date().toISOString()) {
    for (const result of results) {
      const pending = this.pendingToolCalls.get(result.tool_call_id);
      if (!pending) continue;
      const duration_ms = new Date(timestamp).getTime() - new Date(pending.started_at).getTime();
      this.toolCalls.push({ run_id: this.runId, turn_number: pending.turn_number, tool_id: result.tool_call_id, tool_name: pending.tool_name, arguments_json: JSON.stringify(pending.arguments), result_json: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), started_at: pending.started_at, completed_at: timestamp, duration_ms, success: result.is_error ? 0 : 1, error_message: result.is_error ? result.content : null });
      this.steps.push({ run_id: this.runId, step_number: this.currentStep++, step_type: 'tool_result', input: pending.tool_name, output: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), started_at: pending.started_at, completed_at: timestamp, duration_ms, success: result.is_error ? 0 : 1, error_message: result.is_error ? result.content : null });
      this.pendingToolCalls.delete(result.tool_call_id);
    }
  }

  addCompletion(data) { this.completionData = data; }
  addError(message) { this.errorMessage = message; }

  async flush() {
    try {
      if (this.model) {
        await dbManager.updateRun(this.runId, { model: this.model });
      }
      if (this.steps.length > 0) await dbManager.createStepsBatch(this.steps);
      if (this.toolCalls.length > 0) await dbManager.createToolCallsBatch(this.toolCalls);
    } catch (error) {
      console.error(`[${this.runId}] Failed to flush execution log:`, error);
    }
  }
}

const CONTAINER_CONFIG = {
  IMAGE: 'ecoxai-agent',
  MEMORY_LIMIT: 2 * 1024 * 1024 * 1024,
  CPU_SHARES: 1024,
  TIMEOUT_MS: 48 * 60 * 60 * 1000,
};

const DATASETS_VOLUME = 'ecoxai-datasets';
const WORKSPACE_PREFIX = 'ecoxai-workspace-';

class ContainerManager {
  constructor() {
    this.activeContainers = new Map();
    this.timeoutHandles = new Map();
  }

  async runJob(job, state, onOutput, onComplete, onError, onHypothesesExtracted) {
    const { id, prompt, datasetId, selectedSkills } = job;
    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    let logBuffer = null;

    try {
      // Create run record in database (graceful degradation)
      try {
        await dbManager.createRun({ run_id: runId, job_id: id, prompt, dataset_id: datasetId || null, selected_skills: selectedSkills ? selectedSkills.join(',') : null, started_at: startedAt });
        logBuffer = new ExecutionLogBuffer(runId);
      } catch (dbError) {
        console.warn(`[${id}] Skipping observability (no DB):`, dbError.message);
      }

      // Workspace preparation using volumeManager (CLAUDE.md + task.txt)
      const volumeManager = require('./volumeManager');
      const { prepareWorkspace } = require('./workspacePrep');
      const { enhancedPrompt } = await prepareWorkspace(id, job, state, volumeManager);

      // Build environment variables
      const backendPort = process.env.PORT || 8081;
      const envVars = [
        `TASK=${enhancedPrompt}`,
        `JOB_ID=${id}`,
        `DATASET_ID=${datasetId || ''}`,
        `BACKEND_URL=http://host.docker.internal:${backendPort}`,
      ];

      if (datasetId && state?.datasets?.[datasetId]) {
        const dataset = state.datasets[datasetId];
        envVars.push(`DATASET_FILENAME=${dataset.filename || ''}`);
        envVars.push(`DATASET_RECORDS=${dataset.recordCount || 0}`);
        if (dataset.normalization) {
          envVars.push(`DATASET_NORMALIZED=1`);
          envVars.push(`DATASET_CONFIDENCE=${dataset.normalization.confidence || 0}`);
          envVars.push(`DATASET_DOMAIN=${dataset.normalization.semanticMetadata?.domain || 'unknown'}`);
          envVars.push(`DATASET_DOCUMENT_TYPE=${dataset.normalization.documentType || 'unknown'}`);
          if (dataset.normalization.semanticMetadata) {
            envVars.push(`DATASET_SEMANTIC_JSON=${JSON.stringify(dataset.normalization.semanticMetadata)}`);
          }
        } else {
          envVars.push(`DATASET_NORMALIZED=0`);
        }
      }

      if (selectedSkills && selectedSkills.length > 0) {
        envVars.push(`SELECTED_SKILLS=${selectedSkills.join(',')}`);
      }

      if (process.env.CLAUDE_CODE_USE_FOUNDRY === '1') {
        envVars.push(`CLAUDE_CODE_USE_FOUNDRY=1`);
        envVars.push(`ANTHROPIC_FOUNDRY_RESOURCE=${process.env.ANTHROPIC_FOUNDRY_RESOURCE}`);
        envVars.push(`ANTHROPIC_FOUNDRY_API_KEY=${process.env.ANTHROPIC_FOUNDRY_API_KEY}`);
        if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) envVars.push(`ANTHROPIC_DEFAULT_SONNET_MODEL=${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
      } else {
        envVars.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
        if (process.env.ANTHROPIC_BASE_URL) envVars.push(`ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
      }
      if (process.env.CLAUDE_MODEL) envVars.push(`CLAUDE_MODEL=${process.env.CLAUDE_MODEL}`);

      // Volume mounts: workspace volume + datasets volume
      const binds = [
        `${WORKSPACE_PREFIX}${id}:/workspace`,
        `${DATASETS_VOLUME}:/datasets:ro`,
      ];

      const container = await docker.createContainer({
        Image: CONTAINER_CONFIG.IMAGE,
        Env: envVars,
        HostConfig: {
          Binds: binds,
          Memory: CONTAINER_CONFIG.MEMORY_LIMIT,
          CpuShares: CONTAINER_CONFIG.CPU_SHARES,
          AutoRemove: false,
        },
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
      });

      this.activeContainers.set(id, { containerId: container.id, startTime: Date.now() });
      await container.start();
      onOutput(`[Container ${container.id.substring(0, 12)} started]\n`);

      // Timeout
      const timeoutId = setTimeout(async () => {
        console.log(`Job ${id} timed out`);
        await this.stopJob(id);
        onError(new Error('Container timeout exceeded'));
      }, CONTAINER_CONFIG.TIMEOUT_MS);
      this.timeoutHandles.set(id, timeoutId);

      // Attach to output streams
      const logStream = await container.logs({ follow: true, stdout: true, stderr: true, timestamps: false });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      logStream.on('error', (err) => console.warn(`[${id}] logStream error:`, err.message));
      stdout.on('error', (err) => console.warn(`[${id}] stdout error:`, err.message));
      stderr.on('error', (err) => console.warn(`[${id}] stderr error:`, err.message));
      container.modem.demuxStream(logStream, stdout, stderr);

      let buffer = '';
      const skillsInvoked = new Set();

      stdout.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        const timestamp = new Date().toISOString();
        buffer += text;
        const lines = buffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const skillMatch = line.match(/SKILL_INVOKED:\s*(\S+)/);
          if (skillMatch) skillsInvoked.add(skillMatch[1]);
          try {
            const json = JSON.parse(line);
            const { displayText, logData } = formatClaudeOutput(json);
            if (displayText) onOutput(displayText + '\n');
            if (logData && logBuffer) {
              try {
                switch (logData.type) {
                  case 'init': logBuffer.addInitData(logData); break;
                  case 'assistant_message': logBuffer.addAssistantMessage(logData, timestamp); break;
                  case 'tool_results': logBuffer.addToolResults(logData.results, timestamp); break;
                  case 'completion': logBuffer.addCompletion(logData); break;
                  case 'error': logBuffer.addError(logData.error_message); break;
                }
              } catch (logError) {
                console.warn(`[${id}] Log error:`, logError.message);
              }
            }
          } catch (e) {
            onOutput(line + '\n');
          }
        }
        buffer = lines[lines.length - 1];
      });

      stderr.on('data', (chunk) => { onOutput(`[stderr] ${chunk.toString('utf-8')}`); });

      const result = await container.wait();

      // Clear timeout
      const tid = this.timeoutHandles.get(id);
      if (tid) { clearTimeout(tid); this.timeoutHandles.delete(id); }

      // Collect artifacts from workspace volume
      const artifacts = await this._getArtifacts(id);

      // Flush execution log
      if (logBuffer) {
        try {
          await logBuffer.flush();
          const completedAt = new Date().toISOString();
          const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
          await dbManager.updateRun(runId, {
            completed_at: completedAt,
            duration_ms: durationMs,
            exit_code: result.StatusCode,
            status: (result.StatusCode === 0 || artifacts.length > 0) ? 'completed' : 'failed',
            total_cost_usd: logBuffer.completionData?.total_cost_usd || null,
            num_turns: logBuffer.completionData?.num_turns || logBuffer.currentTurn,
            artifacts_json: JSON.stringify(artifacts),
            skills_invoked: Array.from(skillsInvoked).join(',') || null,
            error_message: logBuffer.errorMessage || null
          });

          const { processJobCompletion } = require('./jobPostCompletion');
          await processJobCompletion({ jobId: id, runId, job, artifacts, exitCode: result.StatusCode, storageService: volumeManager, state, onHypothesesExtracted });
        } catch (dbError) {
          console.warn(`[${id}] Failed to update run record:`, dbError.message);
        }
      }

      try { await container.remove(); } catch (err) { console.error(`Failed to remove container for job ${id}:`, err.message); }
      const runStartedMs = this.activeContainers.get(id)?.startTime ?? Date.now();
      this.activeContainers.delete(id);

      onComplete({
        exitCode: result.StatusCode,
        artifacts,
        skillsInvoked: Array.from(skillsInvoked),
        duration: Date.now() - runStartedMs,
        totalCostUsd: logBuffer?.completionData?.total_cost_usd ?? null,
        numTurns: logBuffer?.completionData?.num_turns ?? logBuffer?.currentTurn ?? null,
      });

    } catch (error) {
      if (logBuffer) {
        try {
          await dbManager.updateRun(runId, { completed_at: new Date().toISOString(), status: 'failed', exit_code: -1, error_message: error.message });
        } catch (_) {}
      }
      this.activeContainers.delete(id);
      const tid = this.timeoutHandles.get(id);
      if (tid) { clearTimeout(tid); this.timeoutHandles.delete(id); }
      onError(error);
    }
  }

  async _getArtifacts(jobId) {
    const artifacts = [];
    try {
      const checkContainer = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', `
          if [ -d /workspace/output ]; then find /workspace/output -type f; fi
          find /workspace -maxdepth 1 -type f \\( -name '*.json' -o -name '*.csv' -o -name '*.txt' -o -name '*.png' -o -name '*.jpg' -o -name '*.md' -o -name '*.html' \\)
        `],
        HostConfig: { Binds: [`${WORKSPACE_PREFIX}${jobId}:/workspace:ro`], AutoRemove: false },
      });

      await checkContainer.start();
      const result = await checkContainer.wait();
      const logStream = await checkContainer.logs({ stdout: true, stderr: true });

      let output = '';
      if (Buffer.isBuffer(logStream)) {
        let offset = 0;
        while (offset < logStream.length) {
          if (offset + 8 > logStream.length) break;
          const header = logStream.slice(offset, offset + 8);
          const size = header.readUInt32BE(4);
          if (offset + 8 + size > logStream.length) break;
          output += logStream.slice(offset + 8, offset + 8 + size).toString('utf-8');
          offset += 8 + size;
        }
      } else {
        output = logStream.toString();
      }

      await checkContainer.remove().catch(() => {});

      if (result.StatusCode === 0) {
        const lines = output.trim().split('\n').filter(l => l.trim().length > 0);
        const filePaths = lines.filter(l => l.startsWith('/workspace/output/') || (l.startsWith('/workspace/') && !l.includes('/.')));
        for (const filePath of filePaths) {
          const filename = filePath.split('/').pop();
          // Read artifact content
          try {
            const volumeManager = require('./volumeManager');
            const content = (await volumeManager.readArtifact(jobId, filename.startsWith('/') ? filename : filePath.replace('/workspace/', ''))).toString('utf-8');
            artifacts.push({ name: filename, path: filePath.replace('/workspace/', ''), jobId, content });
          } catch (readErr) {
            artifacts.push({ name: filename, path: filePath.replace('/workspace/', ''), jobId });
          }
        }
      }
    } catch (error) {
      console.error(`[${jobId}] Error getting artifacts:`, error.message);
    }
    console.log(`[${jobId}] Collected ${artifacts.length} artifact(s)`);
    return artifacts;
  }

  async stopJob(jobId) {
    const containerInfo = this.activeContainers.get(jobId);
    if (!containerInfo) return false;
    try {
      const container = docker.getContainer(containerInfo.containerId);
      await container.stop({ t: 10 });
      await container.remove();
      this.activeContainers.delete(jobId);
      const tid = this.timeoutHandles.get(jobId);
      if (tid) { clearTimeout(tid); this.timeoutHandles.delete(jobId); }
      return true;
    } catch (error) {
      console.error(`Error stopping job ${jobId}:`, error.message);
      this.activeContainers.delete(jobId);
      return false;
    }
  }

  isJobRunning(jobId) { return this.activeContainers.has(jobId); }

  getActiveJobs() {
    return Array.from(this.activeContainers.entries()).map(([jobId, info]) => ({
      jobId, containerId: info.containerId, runningTime: Date.now() - info.startTime
    }));
  }

  async healthCheck() {
    try {
      await docker.ping();
      const images = await docker.listImages({ filters: { reference: [CONTAINER_CONFIG.IMAGE] } });
      return { healthy: true, dockerConnected: true, agentImageExists: images.length > 0 };
    } catch (error) {
      return { healthy: false, dockerConnected: false, error: error.message };
    }
  }
}

module.exports = new ContainerManager();
