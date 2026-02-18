# aigent — Development Plan

> Source of truth for what's done, what's next, and what's planned.
> Read at session start. Update as you go.

## Architecture

```
Host (gatekeeper.tsx)
  ├── TUI (ink v6 + React 19)
  │     ├── client.ts (socket connector, auto-reconnect, command queue)
  │     ├── App.tsx, ChatView.tsx, InputBar.tsx, TextInput.tsx
  │     └── Markdown.tsx (terminal markdown rendering)
  ├── Container lifecycle (start/stop/restart Docker)
  └── Permission engine (mounts, capabilities)
        ↕ Unix socket (NDJSON over /tmp/aigent/worker.sock)
Docker container (worker.ts → server.ts)
  ├── agent.ts (conversation loop, streaming, retry, sub-agents)
  ├── provider.ts (Anthropic + OpenAI abstraction, image support)
  ├── tools.ts (12 tools: exec, read_file, write_file, edit_file, list_files, grep, glob, fetch, tree, patch, spawn_agent, host)
  ├── auth.ts (API key / OAT token handling)
  ├── workspace.ts (memory system)
  ├── profiles.ts (multi-profile, sessions)
  └── compact.ts (context compaction)
```

- TypeScript strict mode, ESM, Node 22
- Gatekeeper/sandbox split: TUI on host, agent in Docker
- `make start` runs gatekeeper (new), `make dev` runs everything in Docker (legacy)
- Protocol: NDJSON over Unix socket (/tmp/aigent/worker.sock)
- See docs/architecture.md for full security design

---

## Done

### Foundation
- [x] Project scaffold, strict TypeScript, Docker, Makefile
- [x] 11 tools: exec, read_file, write_file, edit_file, list_files, grep, glob, fetch, tree, patch, spawn_agent
- [x] Safety: 25-iteration limit, 50KB truncation
- [x] OAT subscription token auth (Claude Code compatible)
- [x] dotenv for .env loading
- [x] read_file with offset/limit for line ranges on large files
- [x] exec with cwd for running commands in specific directories
- [x] glob tool for recursive file finding with pattern matching
- [x] Sub-agent spawning (spawn_agent) with recursion prevention

### TUI
- [x] ink v6 TUI with streaming, chat view, input bar, spinner
- [x] Custom TextInput with readline keybindings (Ctrl+W/U/K/A/E, Alt+B/F)
- [x] Multi-line input (Ctrl+J to insert newline)
- [x] Ctrl+C: cancel/clear, double-tap to exit; Ctrl+D to exit on empty
- [x] Tab autocomplete for slash commands
- [x] Fallback readline REPL for non-TTY
- [x] Human-readable tool summaries
- [x] Markdown rendering (marked + marked-terminal)
- [x] Status line (right-aligned): r:on/off, effort letter, context bar with tokens
- [x] Display thinking blocks (dimmed, last 6 lines)
- [x] Clean startup: screen clear on first connect, no ghost lines

### Agent
- [x] Streaming API responses (tokens appear live)
- [x] Extended thinking (Opus 4.6 adaptive, /reasoning + /effort commands)
- [x] Context compaction at 70% usage
- [x] Thinking indicator (reasoning... vs waiting...)
- [x] Automatic retry on transient errors (429, 5xx, network) with exponential backoff
- [x] Image input support (file paths → base64, /image command, auto-detect in messages)

### Workspace & Memory
- [x] AGENTS.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md loaded into system prompt
- [x] Daily memory files (memory/YYYY-MM-DD.md)
- [x] Default templates in workspace/
- [x] Multi-profile system (/profiles, /profile create, /profile switch)
- [x] Session persistence (/save, /sessions, /load)

### Self-Authoring
- [x] System prompt describes full codebase architecture
- [x] Agent can read/modify its own source at /app/
- [x] Backend/frontend split — server restarts on code change, TUI reconnects
- [x] Auto-save/restore conversation across server restarts
- [x] Polling-based file watcher (works in Docker/WSL2 bind mounts)
- [x] Debounced file watcher (2s settle time — safe for multi-file self-edits)

### Provider Abstraction
- [x] Provider interface in src/provider.ts
- [x] AnthropicProvider (streaming, thinking, cache tracking, images)
- [x] OpenAIProvider (streaming, tool call accumulation, images)
- [x] Factory + auto-detection (AIGENT_PROVIDER, env vars)
- [x] Agent uses Provider interface for all API calls
- [x] Bidirectional OAT tool name mapping (internal ↔ Claude Code)

### Streaming & Cost
- [x] Streaming exec: spawn-based, output streamed to TUI via onToolOutput callback
- [x] Cost tracking: src/pricing.ts with model pricing, displayed in status bar
- [x] Persistent lifetime token tracking: workspace/usage.json, /usage command

### MCP
- [x] Full MCP client over stdio transport (JSON-RPC 2.0, Content-Length framing)
- [x] MCPClient (single server) + MCPManager (multi-server orchestration)
- [x] Tools prefixed mcp_<server>_<name> to avoid collisions
- [x] Config via workspace/mcp.json, graceful shutdown

### Background Tasks
- [x] dispatch_task tool — background agents that don't block conversation
- [x] TaskQueue (src/tasks.ts) with FIFO completion queue
- [x] Dispatcher loop: completed results trigger agent turns when idle
- [x] TaskList UI: running tasks shown with spinners + elapsed time
- [x] /tasks command with running, awaiting review, and history views

### Security
- [x] src/safety.ts: sanitizedEnv(), validateWritePath(), validateFetchUrl(), checkCommandSafety()
- [x] Env sanitization applied to exec, grep, glob, fetch, MCP servers
- [x] Path validation: only /workspace, /app/src, /tmp writable
- [x] SSRF protection: private IPs, localhost, metadata endpoints blocked
- [x] Close stdin on all spawned processes (prevents sudo/passwd hangs)

### Infrastructure
- [x] Docker hardening: cap_drop ALL, no-new-privileges, ulimits, tmpfs, resource limits
- [x] Read-only app mount, writable src and workspace mounts
- [x] Client command queue (reliable message delivery during reconnection)
- [x] Proper cancel support: abort signal through agent → provider → API stream

### Gatekeeper/Sandbox Architecture (Phase 1)
- [x] Gatekeeper on host (gatekeeper.tsx) — TUI + container lifecycle
- [x] Worker in Docker (worker.ts) — server management + file watcher
- [x] Socket in shared directory (/tmp/aigent/worker.sock)
- [x] /app read-only by default — self-modification requires explicit grant
- [x] Mount management: /mount, /unmount, /mounts commands in TUI
- [x] Agent mount requests: request_mount tool → user approves via /grant or /deny
- [x] Forbidden path protection (/, /etc, /home root, etc.)
- [x] Safety paths updated for gatekeeper model (/workspace, /project, /tmp)
- [x] Pre-restart typecheck in worker file watcher
- [x] Legacy backward compat: make dev still works (everything in Docker)

---

## Next Up

### Gatekeeper (Phase 2 — LLM proxy + workspace split)
- [ ] LLM proxy: gatekeeper proxies API calls, keys never in sandbox
- [ ] Workspace split: config files (ro) vs memory files (rw)
- [ ] Config writes require gatekeeper approval with diff shown to user
- [ ] Tool call inspection at gatekeeper level

### Gatekeeper (Phase 3 — OS bridge)
- [ ] Clipboard push (/clipboard command, Ctrl+V image paste)
- [ ] File attach (/attach command)
- [ ] Audio play (agent → host speakers)
- [ ] Notifications
- [ ] Timed grants with auto-expiry
- [ ] Audit log
- [ ] Browser plugin integration

### Stabilize
- [x] End-to-end test: gatekeeper/sandbox split works (2026-02-18)
- [x] Pre-restart typecheck: tsc --noEmit before server restart in file watcher
- [ ] Test with OpenAI-compatible endpoint (e.g., Ollama)

### Computer Use
- [ ] Research Anthropic computer-use API
- [ ] Screenshot capture tool
- [ ] Mouse/keyboard action tools

### Polish
- [ ] Better image UX (drag-and-drop paths, URL fetch)
- [ ] Conversation search (/search <term> across past sessions)

---

## Blocked

- **GitHub push**: no SSH in sandbox — Stefano pushes from host
