#!/usr/bin/env bash
#
# ⚠️ TEMPORARY / PROVISIONAL — NOT the canonical entrypoint.
# Reconstructed alongside the stopgap Dockerfile (the repo shipped neither).
# Replace with the original/authoritative ecoxai-agent build when available.
#
# ecoxai-agent entrypoint — drives one headless Claude Code run per container.
#
# The backend injects the prompt via the TASK env var and also writes it to
# /workspace/task.txt. We work in /workspace, where CLAUDE.md and
# .claude/skills/ have already been placed, and stream Claude Code's
# stream-json events to stdout for the backend to parse.

set -uo pipefail

cd /workspace
mkdir -p /workspace/output

# Resolve the task prompt: prefer $TASK, fall back to task.txt.
TASK_PROMPT="${TASK:-}"
if [ -z "${TASK_PROMPT}" ] && [ -f /workspace/task.txt ]; then
  TASK_PROMPT="$(cat /workspace/task.txt)"
fi

if [ -z "${TASK_PROMPT}" ]; then
  echo '{"type":"result","subtype":"error","error_message":"No TASK provided to ecoxai-agent"}'
  exit 1
fi

# Hand off to Claude Code. exec so the CLI's exit code becomes the
# container exit code (the backend treats non-zero + no artifacts as failed).
exec claude \
  --print \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  "${TASK_PROMPT}"
