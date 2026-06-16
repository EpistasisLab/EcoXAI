# EcoXAI

**EcoXAI** is a multiagent automated biomedical analysis framework. It runs a fully automated 5-stage science pipeline — normalize → explore → hypothesize → test → validate — by spawning AI harnessed agents inside isolated Docker containers. The backend coordinates dataset ingestion, pipeline execution, and hypothesis tracking; the frontend is a single-page app for monitoring and interacting with the pipeline in real time.

### Pipeline Stages

| Stage | Description |
|-------|-------------|
| **Normalize** | Structural analysis, content canonicalization, semantic extraction, confidence scoring, and provenance tracking |
| **Explore** | Exploratory data analysis; produces a report and summary artifacts |
| **Hypothesize** | Generates candidate biomedical hypotheses from the explored data |
| **Test** | Runs statistical or ML tests against each hypothesis |
| **Validate** | Cross-validates findings and produces a final report |

---

## Prerequisites

- **Docker** must be running and the `ecoxai-agent` image must be built (see below)
- **Node.js 20+**
- An Anthropic API key (direct or via Azure Foundry)

---

## Setup

### 1. Environment Variables

**Direct Anthropic API:**
```bash
export ANTHROPIC_API_KEY=...
```

**Azure Foundry (alternate):**
```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_RESOURCE=...
export ANTHROPIC_FOUNDRY_API_KEY=...
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6'
```

**Local model (OpenAI-compatible server, e.g. llama.cpp):**
```bash
export ANTHROPIC_BASE_URL="http://localhost:8001"
export ANTHROPIC_API_KEY='sk-no-key-required'
export CLAUDE_MODEL='unsloth/Qwen3.6-27B-MTP-GGUF:UD-Q4_K_XL'
```
> The backend automatically rewrites `localhost` to `host.docker.internal` when passing the URL into Docker containers.

### 2. Build the Agent Docker Image

```bash
cd ecoxai/backend/docker
docker build -t ecoxai-agent -f Dockerfile.agent .
```

### 3. Start the Backend

```bash
cd ecoxai/backend
npm install
npm start
```

### 4. (Optional) Run the Frontend Dev Server

```bash
cd ecoxai/frontend
python3 -m http.server 3000
```

---

## Adding a Dataset

Drop a `.csv`, `.json`, or `.feather` file into `ecoxai/backend/datasets/`. The server watches the directory and automatically ingests the file, triggering the full pipeline.

Click on your dataset after it is ingested to add additional context to the dataset, as well as the research question you are trying to answer.

---

## Resetting State

To wipe all jobs, datasets, Docker volumes, assets, and wikis and start fresh:

```bash
cd ecoxai/backend
./reset.sh
```

---

## Budget Tracking

Each completed agent container reports its cost in USD. Costs are accumulated in backend state and compared against a configurable budget limit before any new job is started. The budget limit can be adjusted in the Settings view of the GUI.
