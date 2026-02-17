.PHONY: dev local rebuild clean

# Run aigent with Claude (default)
dev:
	docker compose run --rm aigent

# Run aigent with a local model (Ollama, GPU if available)
# Override model: AIGENT_LOCAL_MODEL=mistral make local
local:
	docker compose run --rm local

# Full rebuild from scratch
rebuild:
	docker compose build --no-cache

# Clean build artifacts
clean:
	rm -rf dist/
