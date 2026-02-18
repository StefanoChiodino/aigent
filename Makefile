.PHONY: dev run rebuild clean host

# Auto-detect host daemon socket
HOST_SOCK := /tmp/aigent-host.sock
DOCKER_OPTS :=
ifneq (,$(wildcard $(HOST_SOCK)))
  DOCKER_OPTS += -v $(HOST_SOCK):$(HOST_SOCK)
endif

# Build image only if needed, then run
dev: build
	docker compose run --rm -it $(DOCKER_OPTS) aigent

# Run without building (fastest — use after first `make dev`)
run:
	docker compose run --rm -it $(DOCKER_OPTS) aigent

# Build the image (cached — fast if nothing changed)
build:
	docker compose build aigent

# Full rebuild from scratch
rebuild:
	docker compose build --no-cache aigent

# Start the host daemon
host:
	tsx src/host/daemon.ts

# Clean build artifacts
clean:
	rm -rf dist/
