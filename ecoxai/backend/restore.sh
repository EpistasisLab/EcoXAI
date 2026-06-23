#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Argument validation ---
if [ -z "$1" ]; then
  echo "Usage: $0 <path-to-backup.tar.gz>"
  exit 1
fi

ARCHIVE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

if [ ! -f "$ARCHIVE" ]; then
  echo "ERROR: Archive not found: $ARCHIVE"
  exit 1
fi

echo "=== EcoXAI Restore ==="
echo "Archive: $ARCHIVE"
echo ""
echo "WARNING: This will OVERWRITE the current state:"
echo "  - data/state.json"
echo "  - data/executions.db"
echo "  - assets/"
echo "  - data/wikis/"
echo "  - skills/"
echo "  - Docker volume: ecoxai-datasets"
echo ""
read -r -p "Type 'yes' to proceed: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi
echo ""

# --- Check for running jobs (warn only) ---
echo "[0/6] Checking for running jobs..."
if [ -f "$SCRIPT_DIR/data/state.json" ]; then
  NODE_STATE_PATH="$(cygpath -w "$SCRIPT_DIR/data/state.json" 2>/dev/null || echo "$SCRIPT_DIR/data/state.json")"
  RUNNING=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const r = (s.jobs || []).filter(j => j.status === 'running');
    if (r.length) process.stdout.write('RUNNING: ' + r.map(j => j.id).join(', '));
  " -- "$NODE_STATE_PATH" 2>/dev/null || true)
  if [ -n "$RUNNING" ]; then
    echo "      WARNING: Jobs currently running — $RUNNING"
    echo "      These jobs will be interrupted. Proceeding anyway..."
  else
    echo "      No running jobs detected."
  fi
fi

# --- Extract archive ---
STAGING="$(mktemp -d)"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

echo "[1/6] Extracting archive..."
tar -xzf "$ARCHIVE" -C "$STAGING"
echo "      Extracted to $STAGING"

# --- Restore state.json ---
echo "[2/6] Restoring state.json..."
if [ -f "$STAGING/state.json" ]; then
  cp "$STAGING/state.json" "$SCRIPT_DIR/data/state.json"
  echo "      state.json restored."
else
  echo "      WARNING: state.json not found in archive — skipping."
fi

# --- Restore executions.db ---
echo "[3/6] Restoring executions.db..."
if [ -f "$STAGING/executions.db" ]; then
  # Remove stale WAL/SHM files before copying clean DB
  rm -f "$SCRIPT_DIR/data/executions.db-shm" "$SCRIPT_DIR/data/executions.db-wal"
  cp "$STAGING/executions.db" "$SCRIPT_DIR/data/executions.db"
  echo "      executions.db restored (stale -shm/-wal removed)."
else
  echo "      WARNING: executions.db not found in archive — skipping."
fi

# --- Restore assets/ ---
echo "[4/6] Restoring assets/..."
if [ -d "$STAGING/assets" ]; then
  rm -rf "$SCRIPT_DIR/assets"
  cp -a "$STAGING/assets" "$SCRIPT_DIR/assets"
  echo "      assets/ restored."
else
  echo "      WARNING: assets/ not found in archive — skipping."
fi

# --- Restore wikis/ ---
echo "[5/6] Restoring wikis/..."
if [ -d "$STAGING/wikis" ]; then
  rm -rf "$SCRIPT_DIR/data/wikis"
  cp -a "$STAGING/wikis" "$SCRIPT_DIR/data/wikis"
  echo "      wikis/ restored."
else
  echo "      WARNING: wikis/ not found in archive — skipping."
fi

# --- Restore skills/ ---
if [ -d "$STAGING/skills" ]; then
  rm -rf "$SCRIPT_DIR/skills"
  cp -a "$STAGING/skills" "$SCRIPT_DIR/skills"
  echo "      skills/ restored."
fi

# --- Restore Docker volume ecoxai-datasets ---
echo "[6/6] Restoring Docker volume ecoxai-datasets..."
if [ -d "$STAGING/datasets" ]; then
  # Ensure volume exists
  docker volume inspect ecoxai-datasets >/dev/null 2>&1 || docker volume create ecoxai-datasets

  # Clear existing volume content
  docker run --rm \
    -v ecoxai-datasets:/dest \
    alpine sh -c "rm -rf /dest/*"

  # Copy restored data in
  docker run --rm \
    -v "$STAGING/datasets":/source:ro \
    -v ecoxai-datasets:/dest \
    alpine sh -c "cp -a /source/. /dest/"

  echo "      ecoxai-datasets volume restored."
else
  echo "      WARNING: datasets/ not found in archive — volume not modified."
fi

echo ""
echo "=== Restore complete ==="
echo ""
echo "IMPORTANT: Restart the server so it reloads state from disk:"
echo "  node server.js"
