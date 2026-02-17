# aigent — Development Plan

> Source of truth for what's done, what's next, and what's planned.
> Read at session start. Update as you go.

## Architecture

```
Docker container
  └── supervisor.tsx (entrypoint)
        ├── server.ts (child process — agent backend, Unix socket)
        │     ├── agent.ts (conversation loop, streaming)
        │     ├── provider.ts (Anthropic + OpenAI abstraction)
        │     ├── tools.ts (exec, read_file, write_file, edit_file, list_files, grep)
        │     ├── auth.ts (API key / OAT token handling)
        │     ├── workspace.ts (memory system)
        │     ├── profiles.ts (multi-profile, sessions)
        │     └── compact.ts (context compaction)
        └── TUI (in-process — ink v6 + React 19)
              ├── client.ts (socket connector, auto-reconnect)
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
- [x] 6 tools: exec, read_file, write_file, edit_file, list_files, grep
- [x] Safety: 25-iteration limit, 50KB truncation
- [x] OAT subscription token auth (Claude Code compatible)
- [x] dotenv for .env loading

### TUI
- [x] ink v6 TUI with streaming, chat view, input bar, spinner
- [x] Custom TextInput with readline keybindings (Ctrl+W/U/K/A/E, Alt+B/F)
- [x] Ctrl+C: cancel/clear, double-tap to exit
- [x] Tab autocomplete for slash commands
- [x] Fallback readline REPL for non-TTY
- [x] Human-readable tool summaries
- [x] Markdown rendering (marked + marked-terminal)
- [x] Status line: r:on/off, effort letter, context bar with tokens

### Agent
- [x] Streaming API responses (tokens appear live)
- [x] Extended thinking (Opus 4.6 adaptive, /reasoning + /effort commands)
- [x] Context compaction at 70% usage
- [x] Thinking indicator (reasoning... vs waiting...)

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

### Provider Abstraction
- [x] Provider interface in src/provider.ts
- [x] AnthropicProvider (streaming, thinking, cache tracking)
- [x] OpenAIProvider (streaming, tool call accumulation)
- [x] Factory + auto-detection (AIGENT_PROVIDER, env vars)
- [ ] **Integrate into agent.ts** (still uses direct Anthropic SDK path)

---

## Next Up

### Integrate Provider Abstraction
- [ ] Refactor agent.ts to use Provider interface for all API calls
- [ ] Update compact.ts to work with any provider
- [ ] Test with OpenAI-compatible endpoint

### Docker Hardening
- [ ] Non-root user in container
- [ ] Resource limits (CPU, memory, disk)
- [ ] Network policy (allow outbound HTTP, block else)
- [ ] Read-only source mount, writable workspace mount

### TUI Polish
- [ ] Display thinking blocks (optional, togglable)
- [ ] Multi-line input support
- [ ] Better error recovery (retry on transient failures)
- [ ] Image input support (file paths/URLs → base64)

### Computer Use
- [ ] Research Anthropic computer-use API
- [ ] Screenshot capture tool
- [ ] Mouse/keyboard action tools

### Gateway Architecture
- [ ] API key isolation (gateway holds keys)
- [ ] Rate limiting, usage tracking
- [ ] Multi-agent support
- [ ] REST API

---

## Blocked

- **GitHub push**: no SSH in sandbox — Stefano pushes from host
