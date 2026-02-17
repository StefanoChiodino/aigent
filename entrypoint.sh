#!/bin/sh
set -e

cd /app

# Ensure node_modules match package.json
# The anonymous volume may have stale deps from a previous build
# We hash package.json and compare to detect when deps need updating
HASH_FILE="node_modules/.pkg-hash"
CURRENT_HASH=$(md5sum package.json 2>/dev/null | cut -d' ' -f1)
STORED_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "none")

if [ ! -d "node_modules/@anthropic-ai" ] || [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
  echo "Installing dependencies..."
  npm ci
  echo "$CURRENT_HASH" > "$HASH_FILE"
fi

cd /workspace

# Run the supervisor (manages server + TUI)
exec tsx --tsconfig /app/tsconfig.json /app/src/supervisor.tsx
