.PHONY: start stop restart build rebuild logs shell dev typecheck clean

# Start aigent (interactive)
start:
	docker compose run --rm aigent

# Start in background
up:
	docker compose up -d

# Stop
stop:
	docker compose down

# Restart
restart:
	docker compose restart

# Build Docker image
build:
	docker compose build

# Full rebuild (no cache)
rebuild:
	docker compose build --no-cache

# View logs
logs:
	docker compose logs -f

# Shell into running container
shell:
	docker compose exec aigent /bin/bash

# Local dev (no Docker, requires Node 22+)
dev:
	npm run dev

# Type check without building
typecheck:
	npx tsc --noEmit

# Clean build artifacts
clean:
	rm -rf dist/
