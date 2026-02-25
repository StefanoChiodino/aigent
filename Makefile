.PHONY: dev dev-ts serve web web-dev build rebuild typecheck test test-e2e test-e2e-fast test-e2e-spec test-e2e-live test-e2e-ui clean stt stt-setup tts tts-setup kill-ports plugin plugin-dev plugin-typecheck

# --- Development ---

# Run gatekeeper + vite dev server (HMR on :5173, backend on :3141) + Chrome plugin watch
dev-ts:
	@npx concurrently \
		--names "gate,web,plugin" \
		--prefix-colors "cyan,blue,green" \
		--kill-others-on-fail \
		"npx tsx watch src/gatekeeper.tsx --headless $(ARGS)" \
		"npx vite dev --config web/vite.config.ts" \
		"cd aigent-extension && npm run dev"

# Run everything: gatekeeper + vite dev server + TTS + STT + Chrome plugin watch
dev: kill-ports
	@npx concurrently \
		--names "gate,web,tts,stt,plugin" \
		--prefix-colors "cyan,blue,yellow,magenta,green" \
		--kill-others-on-fail \
		"npx tsx watch src/gatekeeper.tsx --headless $(ARGS)" \
		"npx vite dev --config web/vite.config.ts" \
		"$(TTS_PYTHON) tts/main.py" \
		"$(STT_PYTHON) stt/main.py --eager" \
		"cd aigent-extension && npm run dev"

# Server only (no frontend rebuild)
serve:
	npx tsx watch src/gatekeeper.tsx --headless $(ARGS)

# --- Web UI ---

web:
	npx vite build --config web/vite.config.ts

web-dev:
	npx vite dev --config web/vite.config.ts

# --- Build ---

build:
	docker compose build aigent

rebuild:
	docker compose build --no-cache aigent

# --- Quality gate (run before every commit) ---

check: typecheck test test-web web plugin
	@echo "\n✅ All checks passed."

# --- Utilities ---

typecheck:
	npx tsc --noEmit

test:
	node --import tsx/esm --test src/**/*.test.ts

test-web:
	npx vitest run --config web/vite.config.ts

test-e2e:
	AIGENT_TEST_MODE=1 npx playwright test --config tests/playwright.config.ts --grep-invert @live

# Run a single spec or glob, e.g. make test-e2e-spec SPEC=tests/specs/10-settings.spec.ts
test-e2e-spec:
	AIGENT_TEST_MODE=1 npx playwright test --config tests/playwright.config.ts $(SPEC) --reporter=line

# Fast subset — inject-based tests only (~10s), great for quick feedback
test-e2e-fast:
	AIGENT_TEST_MODE=1 npx playwright test --config tests/playwright.config.ts --grep @fast --reporter=line

test-e2e-live:
	AIGENT_TEST_MODE=1 npx playwright test --config tests/playwright.config.ts --grep @live

test-e2e-ui:
	AIGENT_TEST_MODE=1 npx playwright test --config tests/playwright.config.ts --ui

# --- Chrome Plugin ---

plugin:
	cd aigent-extension && npm run build

plugin-dev:
	cd aigent-extension && npm run dev

plugin-typecheck:
	cd aigent-extension && npx tsc --noEmit

clean:
	rm -rf dist/ web/dist/ aigent-extension/dist/

# Kill any lingering processes on dev ports and stale worker containers before starting
kill-ports:
	@for port in 3141 8765 8766; do \
		pid=$$(lsof -ti tcp:$$port 2>/dev/null); \
		if [ -n "$$pid" ]; then \
			echo "--> Killing stale process on port $$port (pid $$pid)"; \
			kill $$pid 2>/dev/null || true; \
		fi; \
	done
	@stale=$$(docker ps -q --filter 'name=aigent-worker-' 2>/dev/null); \
	if [ -n "$$stale" ]; then \
		echo "--> Stopping stale aigent-worker containers"; \
		docker stop $$stale 2>/dev/null || true; \
	fi

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
