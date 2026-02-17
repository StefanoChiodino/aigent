# aigent 🌸

A minimal AI agent platform. CLI-first, Docker-sandboxed, self-authoring.

## Quick Start

```bash
# 1. Create .env with your API key
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
echo 'AIGENT_MODEL=claude-opus-4-6' >> .env

# 2. Run locally (requires Node.js 22+)
npm install
npm run build
npm run start

# 3. Or run in Docker
docker compose run --rm aigent
```

## Auth

Supports both:
- **API keys** (`sk-ant-api03-...`) — pay-per-token
- **Subscription tokens** (`sk-ant-oat01-...`) — from `claude setup-token` / Claude Code

OAT tokens automatically enable Claude Code compatible mode.

## Tools

The agent has access to:
- `exec` — Run shell commands
- `read_file` — Read files
- `write_file` — Write/create files
- `edit_file` — Surgical find-and-replace edits
- `list_files` — List directory contents
- `grep` — Search file contents

## Commands

In the REPL:
- `/reset` — Clear conversation history
- `/status` — Show conversation info
- `/help` — Show available commands
- `Ctrl+C` — Exit

## Architecture

```
src/
  index.ts   — CLI entry point, REPL loop
  agent.ts   — Conversation loop with Claude API
  auth.ts    — API key / OAT token handling
  tools.ts   — Tool definitions and execution
```

## Docs

Research and design notes live in `docs/`.
