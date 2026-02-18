#!/bin/sh
set -e

cd /app

# Ensure node_modules match package.json
HASH_FILE="node_modules/.pkg-hash"
CURRENT_HASH=$(md5sum package.json 2>/dev/null | cut -d' ' -f1)
STORED_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "none")

if [ ! -d "node_modules/@anthropic-ai" ] || [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
  echo "Installing dependencies..."
  npm ci
  echo "$CURRENT_HASH" > "$HASH_FILE"
fi

cd /workspace

# Start virtual display for screenshot support
if [ -z "$DISPLAY" ]; then
  export DISPLAY=:99
  mkdir -p /tmp/.X11-unix
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  sleep 0.3
fi

# Detect mode:
#   Interactive TTY (make dev/run) → supervisor (server + TUI, legacy)
#   Non-interactive (make start)  → worker (server only, gatekeeper runs TUI on host)
if [ -t 0 ] && [ -t 1 ]; then
  exec tsx --tsconfig /app/tsconfig.json /app/src/supervisor.tsx
else
  exec tsx --tsconfig /app/tsconfig.json /app/src/worker.ts
fi
