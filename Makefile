.PHONY: dev serve web web-watch build rebuild typecheck clean

# --- Development ---

# Run everything with hot reload (server + web frontend)
# Server restarts on .ts changes, frontend rebundles on save
dev:
	@mkdir -p web/dist
	@echo "Starting dev server with hot reload..."
	@echo "Web UI: http://localhost:$${AIGENT_WEB_PORT:-3141}"
	@npx esbuild web/src/app.ts --bundle --outfile=web/dist/app.js --format=esm --watch '--external:/vendor/*' & \
	npx tsx --watch=forever src/gatekeeper.tsx --headless $(ARGS); \
	kill %1 2>/dev/null; wait

# Server only (no frontend rebuild)
serve:
	npx tsx --watch=forever src/gatekeeper.tsx --headless $(ARGS)

# --- Web UI ---

web:
	@mkdir -p web/dist
	npx esbuild web/src/app.ts --bundle --outfile=web/dist/app.js --format=esm --minify '--external:/vendor/*'

web-watch:
	@mkdir -p web/dist
	npx esbuild web/src/app.ts --bundle --outfile=web/dist/app.js --format=esm --watch '--external:/vendor/*'

# --- Build ---

build:
	docker compose build aigent

rebuild:
	docker compose build --no-cache aigent

# --- Utilities ---

typecheck:
	npx tsc --noEmit

clean:
	rm -rf dist/ web/dist/
