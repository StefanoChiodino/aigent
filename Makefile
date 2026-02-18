.PHONY: start dev run build rebuild clean

# --- Primary: gatekeeper on host, worker in Docker ---

# Start aigent (gatekeeper + sandbox)
start:
	tsx src/gatekeeper.tsx $(ARGS)

# --- Legacy: everything in Docker (backward compat) ---

# Build + run in Docker (old architecture)
dev: build
	docker compose run --rm -it aigent

# Run without building
run:
	docker compose run --rm -it aigent

# --- Build ---

build:
	docker compose build aigent

rebuild:
	docker compose build --no-cache aigent

# --- Utilities ---

typecheck:
	docker compose run --rm --no-deps aigent npx tsc --noEmit

clean:
	rm -rf dist/
