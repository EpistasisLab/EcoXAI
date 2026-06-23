#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="ecoxai-backup-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${SCRIPT_DIR}/${ARCHIVE_NAME}"
STAGING="$(mktemp -d)"

cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

echo "=== EcoXAI Backup ==="
echo "Timestamp : $TIMESTAMP"
echo "Archive   : $ARCHIVE_PATH"
echo "Staging   : $STAGING"
echo ""

# 1. Checkpoint SQLite WAL so the main file is consistent
echo "[1/5] Checkpointing SQLite WAL..."
if [ -f "$SCRIPT_DIR/data/executions.db" ]; then
  # On Windows/Git Bash, Node.js needs a Windows-style path; cygpath converts it.
  NODE_DB_PATH="$(cygpath -w "$SCRIPT_DIR/data/executions.db" 2>/dev/null || echo "$SCRIPT_DIR/data/executions.db")"
  node -e "
    const D = require('better-sqlite3')(process.argv[1]);
    D.pragma('wal_checkpoint(TRUNCATE)');
    D.close();
  " -- "$NODE_DB_PATH"
  echo "      WAL checkpoint complete."
else
  echo "      executions.db not found — skipping checkpoint."
fi

# 2. Copy file-based state
echo "[2/5] Copying file-based state..."

if [ -f "$SCRIPT_DIR/data/state.json" ]; then
  cp "$SCRIPT_DIR/data/state.json" "$STAGING/state.json"
  echo "      state.json copied."
else
  echo "      WARNING: state.json not found — skipping."
fi

if [ -f "$SCRIPT_DIR/data/executions.db" ]; then
  cp "$SCRIPT_DIR/data/executions.db" "$STAGING/executions.db"
  echo "      executions.db copied."
fi

if [ -d "$SCRIPT_DIR/assets" ]; then
  cp -a "$SCRIPT_DIR/assets/." "$STAGING/assets/"
  echo "      assets/ copied."
else
  mkdir -p "$STAGING/assets"
  echo "      assets/ not found — empty placeholder created."
fi

if [ -d "$SCRIPT_DIR/data/wikis" ]; then
  mkdir -p "$STAGING/wikis"
  cp -a "$SCRIPT_DIR/data/wikis/." "$STAGING/wikis/"
  echo "      wikis/ copied."
else
  mkdir -p "$STAGING/wikis"
  echo "      wikis/ not found — empty placeholder created."
fi

if [ -d "$SCRIPT_DIR/skills" ]; then
  cp -a "$SCRIPT_DIR/skills/." "$STAGING/skills/"
  echo "      skills/ copied."
else
  mkdir -p "$STAGING/skills"
  echo "      skills/ not found — empty placeholder created."
fi

# 3. Export Docker volume ecoxai-datasets
echo "[3/5] Exporting Docker volume ecoxai-datasets..."
mkdir -p "$STAGING/datasets"
if docker volume inspect ecoxai-datasets >/dev/null 2>&1; then
  docker run --rm \
    -v ecoxai-datasets:/source:ro \
    -v "$STAGING/datasets":/dest \
    alpine sh -c "cp -a /source/. /dest/ 2>/dev/null || true"
  echo "      ecoxai-datasets volume exported."
else
  echo "      WARNING: Docker volume ecoxai-datasets not found — skipping."
fi

# 4. Bundle into archive
echo "[4/5] Creating archive..."
tar -czf "$ARCHIVE_PATH" -C "$STAGING" .

# 5. Report
SIZE="$(du -sh "$ARCHIVE_PATH" | cut -f1)"
echo "[5/5] Done."
echo ""
echo "Backup saved: $ARCHIVE_PATH  ($SIZE)"
