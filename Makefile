.PHONY: dev rebuild clean

# Run aigent (builds if needed, interactive, watch mode)
dev:
	docker compose run --rm --build aigent

# Full rebuild from scratch (no cache)
rebuild:
	docker compose build --no-cache

# Clean build artifacts
clean:
	rm -rf dist/
