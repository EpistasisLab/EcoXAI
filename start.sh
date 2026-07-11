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
echo "Starting backend..."
(cd "$SCRIPT_DIR/ecoxai/backend" && npm start) &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend..."
(cd "$SCRIPT_DIR/ecoxai/frontend" && python3 -m http.server 3000 2>/dev/null) &
FRONTEND_PID=$!

# Wait for backend to be ready (up to 20s)
echo "Waiting for backend..."
_tries=0
until curl -s --max-time 1 http://localhost:8081/api/pipeline/status > /dev/null 2>&1; do
  _tries=$((_tries + 1))
  if [ "$_tries" -ge 20 ]; then
    echo "Warning: backend did not respond after 20s — it may still be starting."
    break
  fi
  sleep 1
done

echo ""
echo "EcoXAI ready."
echo "  App:      http://localhost:8081"
echo "  Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl-C to stop."

wait "$BACKEND_PID" "$FRONTEND_PID"
