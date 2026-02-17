# aigent — Development Plan

> Source of truth for what's done, what's next, and what's planned.
> Read at session start. Update as you go.

## Architecture

```
Docker container
  └── supervisor.tsx (entrypoint, debounced file watcher)
        ├── server.ts (child process — agent backend, Unix socket)
        │     ├── agent.ts (conversation loop, streaming, retry, sub-agents)
        │     ├── provider.ts (Anthropic + OpenAI abstraction, image support)
        │     ├── tools.ts (11 tools: exec, read_file, write_file, edit_file, list_files, grep, glob, fetch, tree, patch, spawn_agent)
        │     ├── auth.ts (API key / OAT token handling)
        │     ├── workspace.ts (memory system)
        │     ├── profiles.ts (multi-profile, sessions)
        │     └── compact.ts (context compaction)
        └── TUI (in-process — ink v6 + React 19)
              ├── client.ts (socket connector, auto-reconnect, command queue)
              ├── App.tsx, ChatView.tsx, InputBar.tsx, TextInput.tsx
              └── Markdown.tsx (terminal markdown rendering)
```

- TypeScript strict mode, ESM, Node 22
- Docker-only execution: `make dev` builds + runs
- Backend/frontend split: server restarts on code change, TUI survives
- Protocol: NDJSON over Unix socket (/tmp/aigent.sock)

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

### Infrastructure
- [x] Docker hardening: cap_drop ALL, no-new-privileges, ulimits, tmpfs, resource limits
- [x] Read-only app mount, writable src and workspace mounts
- [x] Client command queue (reliable message delivery during reconnection)

---

## Next Up

### Computer Use
- [ ] Research Anthropic computer-use API
- [ ] Screenshot capture tool
- [ ] Mouse/keyboard action tools

### Gateway Architecture
- [ ] API key isolation (gateway holds keys)
- [ ] Rate limiting, usage tracking
- [ ] Multi-agent support
- [ ] REST API

### Polish
- [ ] Test with OpenAI-compatible endpoint
- [ ] Better image UX (drag-and-drop paths, URL fetch)

---

## Blocked

- **GitHub push**: no SSH in sandbox — Stefano pushes from host
