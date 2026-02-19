.PHONY: dev serve web web-watch build rebuild typecheck clean stt stt-setup tts tts-setup

# --- Development ---

# Run everything with hot reload (server + web frontend)
# Server restarts on .ts changes, frontend rebundles on save
dev:
	@mkdir -p web/dist
	@echo "Starting dev server with hot reload..."
	@echo "Web UI: http://localhost:$${AIGENT_WEB_PORT:-3141}"
	@npx esbuild web/src/app.ts --bundle --outfile=web/dist/app.js --format=esm '--watch=forever' '--external:/vendor/*' & \
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

# --- STT (Parakeet speech-to-text sidecar) ---

STT_VENV   := stt/.venv
STT_PYTHON := $(STT_VENV)/bin/python

# Create the venv and install Parakeet dependencies (run once)
stt-setup:
	python3 -m venv $(STT_VENV)
	$(STT_PYTHON) -m pip install --upgrade pip
	$(STT_PYTHON) -m pip install -r stt/requirements.txt

# Start the STT server (run make stt-setup first)
stt: $(STT_PYTHON)
	$(STT_PYTHON) stt/main.py $(ARGS)

$(STT_PYTHON):
	@echo "STT environment not set up. Run: make stt-setup"
	@exit 1

# --- TTS (edge-tts Microsoft neural text-to-speech sidecar) ---

TTS_VENV   := tts/.venv
TTS_PYTHON := $(TTS_VENV)/bin/python

# Create the venv and install edge-tts (run once)
tts-setup:
	python3 -m venv $(TTS_VENV)
	$(TTS_PYTHON) -m pip install --upgrade pip
	$(TTS_PYTHON) -m pip install -r tts/requirements.txt

# Start the TTS server (run make tts-setup first)
tts: $(TTS_PYTHON)
	$(TTS_PYTHON) tts/main.py $(ARGS)

$(TTS_PYTHON):
	@echo "TTS environment not set up. Run: make tts-setup"
	@exit 1
