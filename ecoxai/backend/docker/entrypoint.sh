#!/bin/bash
set -e

# Read task from environment or file
TASK="${TASK:-$(cat /workspace/task.txt 2>/dev/null || echo 'No task provided')}"

# Obtain Kerberos ticket for CSMC domain if credentials are provided
if [ -n "${KRB5_USER}" ] && [ -n "${KRB5_PASSWORD}" ]; then
    echo "=== Obtaining Kerberos ticket for ${KRB5_USER}@CSMC.EDU ==="
    echo "${KRB5_PASSWORD}" | kinit -l 8h "${KRB5_USER}@CSMC.EDU" 2>&1 && \
        echo "Kerberos ticket obtained successfully" || \
        echo "WARNING: kinit failed — CS_Analyze connection may not work"
fi

# Create output directory if it doesn't exist
mkdir -p /workspace/output

# Change to workspace directory
cd /workspace

# Display task for logging
echo "=== ECOXAI AGENT STARTING ==="
echo "Task: $TASK"
echo "=== EXECUTING ==="
echo ""

# Run Claude Code with the task showing full thought process
# --print for non-interactive output
# --output-format stream-json --verbose gives detailed JSON logs with every tool call
# --dangerously-skip-permissions bypasses permission prompts
# Output raw JSON stream - backend will parse and format it
# NOTE: Prompt must come BEFORE --allowedTools or it won't be recognized

MODEL_FLAG=""
if [ -n "${CLAUDE_MODEL}" ]; then
    MODEL_FLAG="--model ${CLAUDE_MODEL}"
fi

# Bootstrap ~/.claude so Claude Code skips the "not logged in" gate in non-interactive mode.
# Required when the workspace volume is fresh and no prior OAuth session exists.
mkdir -p /workspace/.claude
if [ ! -f /workspace/.claude/settings.json ]; then
    printf '{"hasCompletedOnboarding":true,"skipDangerousModePermissionPrompt":true}' \
        > /workspace/.claude/settings.json
fi

claude $MODEL_FLAG --print --output-format stream-json --verbose --dangerously-skip-permissions "$TASK" --allowedTools "Bash(python*),Bash(pip*),Read,Write,Edit,Glob,Grep"

# Capture exit code
EXIT_CODE=$?

echo ""
echo "=== AGENT COMPLETED ==="
echo "Exit code: $EXIT_CODE"

# List any generated output files
if [ -d "/workspace/output" ] && [ "$(ls -A /workspace/output 2>/dev/null)" ]; then
    echo "Generated files:"
    ls -la /workspace/output/
fi

exit $EXIT_CODE
