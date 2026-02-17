#!/bin/sh
set -e

# Ensure node_modules are installed (anonymous volume may start empty)
if [ ! -d "/app/node_modules/@anthropic-ai" ]; then
  echo "Installing dependencies..."
  cd /app && npm ci && cd /workspace
fi

# Run the supervisor
exec tsx --tsconfig /app/tsconfig.json /app/src/supervisor.ts
