#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  echo "All processes stopped."
}

trap cleanup EXIT INT TERM

# Build Docker image if not present
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

# Install backend dependencies if needed
if [ ! -d "$SCRIPT_DIR/ecoxai/backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  (cd "$SCRIPT_DIR/ecoxai/backend" && npm install)
fi

# Start backend
echo "Starting backend on http://localhost:8081 ..."
(cd "$SCRIPT_DIR/ecoxai/backend" && npm start) &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend on http://localhost:3000 ..."
(cd "$SCRIPT_DIR/ecoxai/frontend" && python3 -m http.server 3000) &
FRONTEND_PID=$!

echo ""
echo "EcoXAI running."
echo "  App:      http://localhost:8081"
echo "  Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl-C to stop."

wait "$BACKEND_PID" "$FRONTEND_PID"
