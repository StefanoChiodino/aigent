.PHONY: dev dev-full serve web web-watch build rebuild typecheck test test-e2e test-e2e-spec test-e2e-live test-e2e-ui clean stt stt-setup tts tts-setup

# --- Development ---

# Run gatekeeper + web frontend watcher
dev-ts:
	@mkdir -p web/dist
	@npx concurrently \
		--names "gate,web" \
		--prefix-colors "cyan,blue" \
		--kill-others-on-fail \
		"npx tsx watch src/gatekeeper.tsx --headless $(ARGS)" \
		"npx esbuild web/src/app.ts --bundle --outfile=web/dist/app.js --format=esm --watch '--external:/vendor/*'"

# Run everything: gatekeeper + web watcher + TTS + STT
dev:
	@mkdir -p web/dist
	@npx concurrently \
		--names "gate,web,tts,stt" \
		--prefix-colors "cyan,blue,yellow,magenta" \
		--kill-others-on-fail \
		"npx tsx watch src/gatekeeper.tsx --headless $(ARGS)" \
		"npx esbuild web/src/app.ts --bundle --outfile=web/dist/app.js --format=esm --watch '--external:/vendor/*'" \
		"$(TTS_PYTHON) tts/main.py" \
		"$(STT_PYTHON) stt/main.py --eager"

# Server only (no frontend rebuild)
serve:
	npx tsx watch src/gatekeeper.tsx --headless $(ARGS)

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

test:
	node --import tsx/esm --test src/**/*.test.ts

test-e2e:
	AIGENT_TEST_MODE=1 AIGENT_WEB_PORT=3142 npx playwright test --config tests/playwright.config.ts --grep-invert @live

# Run a single spec or glob, e.g. make test-e2e-spec SPEC=tests/specs/10-settings.spec.ts
test-e2e-spec:
	AIGENT_TEST_MODE=1 AIGENT_WEB_PORT=3142 npx playwright test --config tests/playwright.config.ts $(SPEC) --reporter=line

test-e2e-live:
	AIGENT_TEST_MODE=1 AIGENT_WEB_PORT=3142 npx playwright test --config tests/playwright.config.ts --grep @live

test-e2e-ui:
	AIGENT_TEST_MODE=1 AIGENT_WEB_PORT=3142 npx playwright test --config tests/playwright.config.ts --ui

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
