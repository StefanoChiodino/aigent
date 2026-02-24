# aigent — Project Instructions

> **Read this first.** This is the bootstrap document for any agent (human or AI) working on this project.

## What This Is

A self-authoring AI agent — an open-source Claude Code / OpenClaw-style coding assistant that can edit its own source code. It runs in a sandboxed Docker container with a gatekeeper on the host enforcing least-privilege access.

**Current interface:** Web UI. The web is also the path to microphone, webcam, and other browser APIs we'll need later.

**LLM support:** Anthropic subscriptions (OAT tokens) are the priority. OpenAI provider exists. Eventually support everything (Ollama, etc.), like OpenClaw does.

## Architecture

```
Host (gatekeeper.tsx)
  ├── Web UI — user-facing interface
  ├── Container lifecycle (start/stop/restart Docker)
  ├── LLM proxy (API keys never enter sandbox)
  └── Permission engine (mounts, capabilities)
        ↕ Unix socket (NDJSON over /tmp/aigent/worker.sock)
Docker container (worker.ts → server.ts)
  ├── agent.ts — conversation loop, streaming, retry, sub-agents
  ├── provider.ts — Anthropic + OpenAI abstraction
  ├── tools.ts — 12 tools (exec, read/write/edit files, grep, glob, fetch, etc.)
  ├── workspace.ts — memory system (AGENTS.md, SOUL.md, USER.md, MEMORY.md)
  ├── compact.ts — context compaction at 70% usage
  └── mcp.ts — Model Context Protocol client
```

**Key principle:** The gatekeeper is the security boundary. The sandbox is disposable. API keys, mounts, and permissions are all controlled from the host side. The agent must request access — it doesn't have ambient privileges.

## Design Principles

1. **Least privilege** — No ambient access to anything. Mounts are explicit and scoped (ro/rw). If the agent needs `~/projects`, it asks and the user grants temporarily.
2. **Self-modification** — The agent can read/edit its own source at `/app/src`. Changes trigger typecheck + server restart. Conversation survives restarts.
3. **Single stream, sub-agents** — One conversation thread for the user. Background sub-agents can be spawned, but results are presented one at a time. The agent is the user's interface, not a firehose.
4. **Slash commands** — Claude Code-style commands for controlling thinking/reasoning, clearing context, managing sessions, profiles, etc.
5. **Safety first** — Docker hardening (cap_drop ALL, no-new-privileges), path validation, SSRF protection, command safety checks. Defense in depth.

## Key Files

| Area | Files |
|------|-------|
| Entry points | `src/gatekeeper.tsx` (host), `src/worker.ts` (sandbox), `src/index.tsx` (legacy) |
| Core agent | `src/agent.ts`, `src/server.ts`, `src/client.ts` |
| Tools | `src/tools.ts`, `src/safety.ts` |
| LLM | `src/provider.ts`, `src/llm-proxy.ts`, `src/socket-provider.ts` |
| UI | `src/ui/App.tsx`, `src/ui/ChatView.tsx`, `src/ui/InputBar.tsx` |
| Web UI | `web/index.html`, `web/src/app.ts`, `src/web-bridge.ts` |
| Memory | `workspace/config/` (AGENTS.md, SOUL.md, etc.), `workspace/memory/` |
| Docs | `docs/PLAN.md` (roadmap), `docs/architecture.md`, `docs/tui-architecture.md` |
| Infra | `Dockerfile`, `docker-compose.yml`, `Makefile`, `package.json` |

## Development Rules

1. **Check TODO.md before starting work.** They track what's done and what's next. Don't build something that already exists. Don't start something that isn't prioritized unless the user asks.
2. **Update TODO.md when you finish something.** Check off completed items. Add new items you discover. This is how continuity works across sessions.
3. **Update docs/PLAN.md for architectural changes.** If you add a feature, move it from "Next Up" to "Done". If you discover something new that needs doing, add it.
4. **No `console.log` while TUI is active** — it breaks Ink rendering. Log to `/tmp/aigent-server.log`.
5. **Run `npx tsc --noEmit` before considering code changes done.** The worker file-watcher does this before restarting, but you should too.
6. **TypeScript strict mode, ESM, Node 22+.** No CommonJS. No `any` unless absolutely necessary.
7. **Don't over-engineer.** This project moves fast. Simple and working beats clever and abstract.
8. **Self-edits are real.** When aigent modifies its own source, changes persist on the host filesystem and survive container restarts.

## Current State

See [docs/PLAN.md](docs/PLAN.md) for the full roadmap. Short version:

- **Done:** Core agent, 12 tools, streaming, extended thinking, context compaction, provider abstraction (Anthropic + OpenAI), MCP client, background tasks, multi-profile/sessions, Docker sandboxing, gatekeeper/sandbox split (Phase 1), LLM proxy, workspace memory system, self-modification with auto-restart.
- **In progress:** Web UI, gatekeeper Phase 2 (tool inspection, config write approval).
- **Next:** OS bridge (clipboard, audio, notifications), computer use, browser plugin.
- **Blocked:** Git push from sandbox (no SSH in container — push from host).

## TODO.md

`TODO.md` in the project root tracks immediate work items. **This is the async handoff mechanism between sessions.** When you start a session:

1. Read TODO.md
2. Check if anything is stale or already done
3. Ask the user what to work on (don't just pick something)
4. Update it as you go
