#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build the agent image if missing (needed for pipeline jobs)
if ! docker image inspect ecoxai-agent > /dev/null 2>&1; then
  echo "Docker image 'ecoxai-agent' not found. Building..."
  docker build \
    -f "$SCRIPT_DIR/ecoxai/backend/docker/Dockerfile.agent" \
    -t ecoxai-agent \
    "$SCRIPT_DIR/ecoxai/backend/docker/"
  echo "Docker image built."
else
  echo "Docker image 'ecoxai-agent' found."
fi

echo ""
echo "Starting EcoXAI (Docker)..."
echo "  App:      http://localhost:8081"
echo "  Frontend: http://localhost:3000"
echo ""

docker compose -f "$SCRIPT_DIR/docker-compose.yml" up --build "$@"
