# ⚠️ TEMPORARY / PROVISIONAL — NOT the canonical image.
# This Dockerfile was reconstructed by inferring the agent-image contract from
# the backend code and docker/CLAUDE.md (the repo shipped no Dockerfile). It is
# a stopgap so the pipeline can run; replace it with the original/authoritative
# ecoxai-agent image when available. Details may differ from the intended build.
#
# ecoxai-agent — sandboxed autonomous data-science agent image
#
# Runs the Claude Code CLI headlessly inside a container. The backend
# (containerManager.js) starts one container per pipeline job with:
#   - volumes:  workspace -> /workspace (rw), datasets -> /datasets (ro)
#   - env:      TASK, JOB_ID, DATASET_*, and Foundry/Anthropic credentials
#   - no Cmd override, so this image's ENTRYPOINT drives the whole run.
#
# The agent reads its prompt from $TASK (or /workspace/task.txt), works in
# /workspace (where the backend has placed CLAUDE.md and .claude/skills/),
# and writes deliverables to /workspace/output/. stdout must be the
# Claude Code stream-json event stream, which the backend parses line by line.
#
# Build:  docker build -t ecoxai-agent:latest ecoxai/backend/docker
FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# System tooling the agent relies on (git + ripgrep for code/data search).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        git \
        ripgrep \
        ca-certificates \
        curl \
        jq \
    && rm -rf /var/lib/apt/lists/*

# Python data-science stack for the analysis the agent performs.
# Debian 12 enforces PEP 668, so install into the system interpreter explicitly.
RUN pip3 install --no-cache-dir --break-system-packages \
        pandas \
        numpy \
        scipy \
        scikit-learn \
        matplotlib \
        seaborn \
        statsmodels \
        pyarrow \
        openpyxl

# Claude Code CLI (provides the `claude` binary the entrypoint invokes).
RUN npm install -g @anthropic-ai/claude-code

# Marks this as a sandboxed environment so the CLI permits running as root
# with --dangerously-skip-permissions (the container is the isolation boundary).
ENV IS_SANDBOX=1

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
