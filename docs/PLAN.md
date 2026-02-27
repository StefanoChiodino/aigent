# aigent — Development Plan

> Source of truth for what's done, what's next, and what's planned.
> Read at session start. Update as you go.

## Architecture

```
Host (gatekeeper.tsx)
  ├── Safety Engine (three-tier: static deny → static allow → Haiku classifier)
  ├── LLM Proxy (holds API keys)
  ├── Web UI Bridge (HTTP + WebSocket)
  ├── Permission Engine (exec, fetch, file edit, browser actions)
  └── OS Bridge (clipboard, audio, screen, browser extension)
        ↕ Unix socket (NDJSON over /tmp/aigent/worker.sock)
Server process (spawned directly, no Docker)
  ├── agent.ts (conversation loop, streaming, retry, sub-agents)
  ├── provider.ts (Anthropic + OpenAI abstraction, image support)
  ├── tools.ts (exec, read_file, write_file, edit_file, list_files, grep, glob, fetch, tree, patch, spawn_agent, host)
  ├── auth.ts (API key / OAT token handling)
  ├── workspace.ts (memory system)
  ├── profiles.ts (multi-profile, sessions)
  └── compact.ts (context compaction)
```

- TypeScript strict mode, ESM, Node 22
- No Docker — agent runs directly on host, gated by three-tier safety engine
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
- [x] Agent can read/modify its own source
- [x] Backend/frontend split — server restarts on code change, TUI reconnects
- [x] Auto-save/restore conversation across server restarts
- [x] Polling-based file watcher (works in bind mounts)
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

### Security — Three-Tier Command Safety
- [x] Docker sandbox (gatekeeper/container split) — superseded by host-native safety
- [x] Removed Docker dependency — agent runs directly on host
- [x] Tier 1: Static deny — shell injection ($(), backticks), credential paths, system destruction, privilege escalation, exfiltration patterns
- [x] Tier 2: Static allow/deny from settings.json — glob-based exec_permissions with ~40 default safe patterns
- [x] Tier 3: Haiku classifier — LLM-based command evaluation for ambiguous commands, cached, ~$0.001/call
- [x] src/safety.ts: sanitizedEnv(), validateFetchUrl(), checkCommandSafety(), checkTier1Deny(), checkExecPermission()
- [x] Env sanitization applied to exec, grep, glob, fetch, MCP servers
- [x] SSRF protection: private IPs, localhost, metadata endpoints blocked
- [x] Close stdin on all spawned processes (prevents sudo/passwd hangs)
- [x] Exec permission learning: --always flag promotes commands to static allow list
- [x] --always-deny: promote commands to static deny list

### Infrastructure
- [x] Read-only workspace config, writable workspace memory
- [x] Client command queue (reliable message delivery during reconnection)
- [x] Proper cancel support: abort signal through agent → provider → API stream

### Browser Automation
- [x] Phase 1 — Observe: extension + WebSocket bridge + `extract_a11y` + `screenshot`
- [x] Phase 2 — Write: `run_script` (batched steps) + `navigate` action
- [x] Phase 3a — Multi-tab + grants: `activate_tab`, `open_tab`, session-level `browser.write` grant
- [x] Prompt injection defense: page content wrapped in untrusted markers
- [x] Phase 3b — Autonomous mode: `browser.autonomous` grant, `close_tab` action, "Go Autonomous" button (2026-02-26)

### Web UI & Extension
- [x] Replace sidepanel iframe with `chrome.windows.create({ type: 'popup' })`
- [x] Delete mic relay chain, isSidepanel branches, sidepanel files

### Memory System
- [x] MEMORY.md as curated short-term memory in system prompt
- [x] Daily logs as archive — index only in prompt, full content on demand
- [x] distillToMemory() on reset and session shutdown
- [x] search_memory tool — keyword grep across daily logs

---

## Next Up

### Browser Automation
- [ ] Phase 3c — Destructive action heuristics for browser actions
- [ ] Headless browser (deferred) — Playwright fallback for unattended/CI runs
- [ ] Computer-use loop (deferred) — screenshot + Anthropic computer-use API

### Memory System
- [ ] Haiku-filtered retrieval — when keyword results are noisy, Haiku filters to relevant chunks
- [ ] RAG with local embeddings — if/when logs span 6+ months

### Web UI
- [ ] PWA manifest + service worker for installable mobile app
- [ ] Test mic/TTS on iOS Safari and Android Chrome

### Polish
- [ ] Better image UX (drag-and-drop paths, URL fetch)
- [ ] Conversation search (/search <term> across past sessions)

---

## Blocked

(nothing currently blocked)
