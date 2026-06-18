#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Resetting lean backend..."

echo '{"jobs":[],"datasets":{},"budget":{"totalCostUsd":0,"jobCount":0,"sessions":[]}}' \
  > "$SCRIPT_DIR/data/state.json"

rm -f "$SCRIPT_DIR/data/executions.db"
rm -rf "$SCRIPT_DIR/assets"
rm -rf "$SCRIPT_DIR/data/wikis"

for vol in $(docker volume ls -q --filter name=ecoxai-workspace) ecoxai-datasets; do
  containers=$(docker ps -a -q --filter volume="$vol")
  [ -n "$containers" ] && docker rm -f $containers 2>/dev/null || true
done

docker volume rm $(docker volume ls -q --filter name=ecoxai-workspace) 2>/dev/null || true
docker volume rm ecoxai-datasets 2>/dev/null || true

echo "Done. Run 'node server.js' to start fresh."
