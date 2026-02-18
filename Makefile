.PHONY: dev run rebuild clean

# Build image only if needed, then run
dev: build
	docker compose run --rm -it aigent

# Run without building (fastest — use after first `make dev`)
run:
	docker compose run --rm -it aigent

# Build the image (cached — fast if nothing changed)
build:
	docker compose build aigent

# Full rebuild from scratch
rebuild:
	docker compose build --no-cache aigent

# Clean build artifacts
clean:
	rm -rf dist/
