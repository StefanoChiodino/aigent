#!/bin/sh
set -e

# If using a local model (openai provider), start Ollama in the background
if [ "$AIGENT_PROVIDER" = "openai" ] || [ "$AIGENT_PROVIDER" = "local" ]; then
  echo "Starting Ollama..."
  ollama serve &
  OLLAMA_PID=$!

  # Wait for Ollama to be ready
  for i in $(seq 1 30); do
    if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
      echo "Ollama ready."
      break
    fi
    sleep 1
  done

  # Pull the model if not already present
  if [ -n "$AIGENT_MODEL" ]; then
    echo "Ensuring model: $AIGENT_MODEL"
    ollama pull "$AIGENT_MODEL" 2>/dev/null || true
  fi

  # Default base URL to local Ollama
  export AIGENT_BASE_URL="${AIGENT_BASE_URL:-http://localhost:11434/v1}"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-not-needed}"
  export AIGENT_PROVIDER="openai"
fi

# Run the supervisor (watches for source changes, gracefully restarts the agent)
exec tsx --tsconfig /app/tsconfig.json /app/src/supervisor.ts
