# aigent — Development Plan

> This file is the source of truth for what's done, what's next, and what's planned.
> Read this at the start of every session. Update it as you go.

## Current State

**v0 CLI agent is functional.** Compiles clean, runs in sandbox, talks to Claude API with OAT auth.

### Architecture

```
src/
  index.ts   — CLI entry, REPL loop, dotenv loading
  agent.ts   — Conversation loop (tool-use cycle, iteration limits)
  auth.ts    — OAT token detection, Claude Code compatible client creation
  tools.ts   — 6 tools: exec, read_file, write_file, edit_file, list_files, grep
```

- TypeScript strict mode, ESM, Node 22
- Dependencies: `@anthropic-ai/sdk`, `dotenv`
- Docker: `node:22-slim`, mounts `./workspace` as `/workspace`
- Auth: supports both API keys (`sk-ant-api03-...`) and OAT tokens (`sk-ant-oat01-...`)

---

## Phase 1: Foundation ✅ DONE

- [x] Project scaffold (package.json, tsconfig, Dockerfile, docker-compose)
- [x] CLI REPL with conversation loop
- [x] Tool-use cycle (exec, read_file, write_file)
- [x] OAT subscription token auth (Claude Code compatible mode)
- [x] dotenv for .env loading
- [x] Git repo with 3 commits on `main`

## Phase 2: Robustness & UX — IN PROGRESS

- [x] edit_file tool (surgical find-replace)
- [x] list_files tool
- [x] grep tool
- [x] REPL commands (/reset, /status, /help)
- [x] Graceful shutdown (SIGINT/SIGTERM)
- [x] Iteration safety limit (25 tool calls per turn)
- [x] Result truncation (50KB cap)
- [x] Response timing display
- [ ] Streaming output (show text as it arrives, not all at once)
- [ ] Conversation persistence (save/load sessions)
- [ ] Token usage tracking & display
- [ ] Better error recovery (retry on transient failures)
- [ ] Multi-line input support
- [ ] Commit all Phase 2 work

## Phase 3: Self-Authoring

- [ ] Agent can read its own source (`/app/src/`)
- [ ] Agent can modify, recompile, and restart itself
- [ ] Hot-reload or restart mechanism after self-edit
- [ ] Safety: git diff / review before applying self-edits
- [ ] Bootstrap prompt: agent can set up its own workspace

## Phase 4: Workspace & Memory

- [ ] Workspace files (SOUL.md, MEMORY.md, etc.) — similar to OpenClaw
- [ ] System prompt loaded from workspace config
- [ ] Session memory (conversation summaries across restarts)
- [ ] Daily memory files (like OpenClaw's memory/ dir)

## Phase 5: Docker Hardening

- [ ] Non-root user in container
- [ ] Resource limits (CPU, memory, disk)
- [ ] Network policy (allow outbound HTTP, block everything else)
- [ ] Read-only source mount, writable workspace mount
- [ ] Health check endpoint

## Phase 6: Streaming & Extended Thinking

- [ ] Streaming API responses (show tokens as they arrive)
- [ ] Extended thinking support (Opus 4.6 adaptive thinking)
- [ ] Display thinking blocks (optional, togglable)
- [ ] Interleaved thinking

## Phase 7: Computer Use

- [ ] Research Anthropic's computer-use API
- [ ] Screenshot capture tool
- [ ] Mouse/keyboard action tools
- [ ] Accessibility API integration
- [ ] VS Code interaction

## Phase 8: Multi-Provider

- [ ] Abstract provider interface
- [ ] OpenAI / GPT support
- [ ] Google Gemini support
- [ ] Provider-specific tool mapping
- [ ] Model config in workspace files

## Phase 9: Gateway Architecture

- [ ] API key isolation (gateway holds keys, agent doesn't)
- [ ] Rate limiting
- [ ] Usage tracking & billing
- [ ] Multi-agent support
- [ ] REST API for external integrations

---

## Blocked

- **GitHub push**: no SSH in sandbox — Stefano needs to push from host
- **Docker build/test**: can't run Docker-in-Docker in sandbox — test locally or in CI

## Notes

- OAT tokens require Claude Code identity headers — see `src/auth.ts` and `docs/secret-management.md`
- dotenv v17 is noisy — we suppress its console.log during loading
- The agent responds as "Claude Code" when using OAT — this is required by the API
- OpenClaw source at `/home/draga/.npm-global/lib/node_modules/openclaw/` is a useful reference
