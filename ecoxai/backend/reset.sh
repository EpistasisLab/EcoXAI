#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Resetting lean backend..."

echo '{"jobs":[],"datasets":{},"budget":{"totalCostUsd":0,"jobCount":0,"sessions":[]}}' \
  > "$SCRIPT_DIR/data/state.json"

rm -f "$SCRIPT_DIR/data/executions.db"
rm -rf "$SCRIPT_DIR/assets"
rm -rf "$SCRIPT_DIR/data/wikis"

docker volume rm $(docker volume ls -q --filter name=ecoxai-workspace) 2>/dev/null || true
docker volume rm ecoxai-datasets 2>/dev/null || true

echo "Done. Run 'node server.js' to start fresh."
