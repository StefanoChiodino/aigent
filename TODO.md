# aigent — TODO

---

## ✅ Implemented Features

### Core Agent
- Streaming responses via Anthropic (Claude) and OpenAI (GPT)
- Extended thinking / reasoning with configurable effort levels (off / low / medium / high / max)
- Per-message thinking boost (`Ctrl+Enter` sends with max reasoning, then reverts)
- Thinking heuristics — auto-lowers effort on short/trivial messages to save tokens
- Context compaction at ~70% usage — conversation summarised in-place, cost-optimised
- Multi-provider support — Anthropic and OpenAI; auto-detected from API key format
- Self-modification — agent can read and edit `/app/src/`; `tsc --noEmit` gate before restart; bad code can't take down the server
- Conversation state auto-saved and restored across restarts
- Background sub-agents via `dispatch_task` — non-blocking, result injected later
- Synchronous sub-agents via `spawn_agent` — blocks until complete
- Model switching mid-conversation via `switch_model` tool (upgrade for complex tasks, downgrade for cheap ones)
- Context window usage shown in status bar with colour-coded bar

### Tools (19)
- `exec` — shell command with timeout, cwd, and permission tiers (allow / prompt / deny)
- `read_file` — file read with line-range support (offset + limit)
- `write_file` — writes a file, creating parent directories as needed
- `edit_file` — surgical exact-string replacement in a file
- `patch` — multiple find-replace edits in one call
- `list_files` — directory listing
- `grep` — regex search with file/line results
- `glob` — recursive file-pattern matching (skips `node_modules` etc.)
- `tree` — directory tree, gitignore-aware
- `fetch` — HTTP requests (all methods, optional HTML→text stripping, SSRF protection)
- `screenshot` — capture sandbox virtual display (Xvfb) as PNG
- `request_screenshot` — capture user's live browser screen (requires screen-share active)
- `dispatch_task` — spawn a background agent; returns immediately, result injected later
- `spawn_agent` — spawn a sub-agent synchronously; blocks until done
- `switch_model` — change active model mid-conversation
- `host` — host OS capabilities: clipboard, audio, notifications, open URLs/files
- `request_mount` — ask user to grant access to a host folder (time-limited, auto-expires)
- `request_config_write` — propose edits to config files; user sees diff before anything is written
- `search_memory` — keyword search across past session logs (zero LLM cost)

### Memory System
- Persistent workspace: `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, daily session logs
- Memory distillation on session end / `/reset` — agent rewrites `MEMORY.md` from the day's logs
- Cache-aware — stable system prompt blocks cached; workspace files skip disk reads when `mtime` unchanged
- Memory index compression — older file previews truncated to 50 chars, capped to last 30 days
- Tool metadata stripped during compaction (bulky `content`, `file_content`, `data`, `base64` fields removed)
- Image deduplication — SHA-256 hashes tracked; duplicate images replaced with text placeholder

### Security
- Docker sandbox with `cap_drop ALL`, `no-new-privileges`, read-only app mount
- API keys never enter the sandbox — gatekeeper is the sole credentialled process
- Environment sanitisation — API keys, tokens, secrets stripped from all child process environments (exec, MCP servers)
- Path validation — writes restricted to `/workspace`, `/project`, `/tmp`; defence-in-depth alongside Docker mounts
- SSRF protection — `fetch` blocks private IPs (RFC 1918, link-local), localhost, cloud metadata endpoints, and non-HTTP(S) protocols
- Read-only command validation for background agents (blocklist + redirect detection)
- Exec permission tiers: `alwaysAllow` / `prompt` / `deny` with glob matching (e.g. `git log *` always allowed, `rm *` prompts, `sudo *` denied)
- Safe default: any unlisted command → `prompt`
- Dangerous command detection: warns on `rm -rf /`, `mkfs`, `dd of=/dev/`, fork bombs, force-push, pipe-to-shell, etc.

### Web UI
- Push-to-talk (`Ctrl+\``) and always-on mic mode (`Ctrl+Shift+\``) with VAD silence detection and interrupt
- Local TTS (edge-tts, no API key) — per-message speaker button, auto-speak toggle, concise mode (cheap model summarises before speaking)
- Local STT (NVIDIA Parakeet) — real-time transcription streamed into input box
- Screen capture via `getDisplayMedia` — grab any window/tab/monitor, attaches as PNG
- Paste / attach images; max attachment size/count configurable in settings
- Model picker — live list fetched from Anthropic API at startup, falls back to hardcoded default, persists across restarts
- Reasoning/effort toggles persist across reloads
- Background task sidebar — live spinner, elapsed time, token/model per task, checkmark/✗ on completion
- Inline tool-call visualisation — name, input summary, output excerpt; collapsed by default, expandable
- Mount sidebar — active mounts with countdown timer; click ✕ to revoke early
- Permission modal — Approve/Deny buttons, ascending 3-tone audio cue, browser notification when tab is backgrounded
- Settings modal — schema-driven, auto-renders toggles/sliders/number inputs; all settings backed by unified `localStorage` key
- Consecutive system messages collapsed into a single box with separator
- `/` slash-command menu
- `Enter` to send, `Shift+Enter` for newline

### MCP (Model Context Protocol) — Plugin System
- Full MCP client — stdio transport, JSON-RPC 2.0, Content-Length framing
- Config via `mcp.json` in workspace; supports multiple servers simultaneously
- Auto-discovery of tools from each server (`tools/list`)
- Tools namespaced as `mcp_{serverName}_{toolName}` to avoid collisions
- Sanitised environment passed to MCP server processes (no API keys)
- Graceful shutdown: SIGTERM → 5 s → SIGKILL

### Token / Cost Optimisation
- Split system prompt caching — stable base instructions cached; workspace context (changes frequently) left uncached
- Dynamic tool output truncation — scales to remaining context budget (`available = window - usage - buffer`; truncates large results proportionally)
- Sub-agent model routing — tool descriptions guide the agent to use Haiku for simple read-only tasks
- Cache hit monitoring — `cacheHitRate%` logged on every response
- Compaction prompt tightened (~100 tokens saved per compaction)
- Workspace `mtime`-gating — config/memory files skip disk reads when unchanged

---

## 🐛 Known Bugs / Open Issues

- [ ] Not all models support reasoning; UI currently allows enabling it on models that don't (e.g. Haiku) — should disable the toggle or warn for incompatible models
- [ ] Agent sometimes re-requests a mount it already holds — mount names in context may not match host paths; agent should receive a clear list of currently mounted paths and the request should be suppressed silently if already mounted
- [ ] Messages disappear on hard browser reload — see UI section below

---

## 🔒 Security & Safety

- [ ] **`fetch` permission tiers** — prompt/allow/deny by domain, analogous to exec permissions; default: `prompt` for any external domain not on an allow-list
- [ ] **`fetch` response size cap** — hard limit (e.g. 10 MB) to prevent large-payload exfiltration or OOM from a malicious URL
- [ ] **`host.open` default to prompt** — currently unrestricted; add domain/scheme policy (e.g. block `file://`, `javascript:`, non-HTTPS)
- [ ] **MCP server permission model** — optional `permissions` block per server in `mcp.json` (allow/prompt/deny); default: `prompt` for all calls from any MCP server
- [ ] **Audit log stream** — structured `[audit]` entries emitted regardless of log level for: permission requests, mount grants/denials, exec allow/prompt/deny outcomes, fetch calls; same KV format as `logger.ts`
- [ ] **Self-mod policy** — explicit list of files/paths the agent may edit autonomously vs. paths that require human approval (e.g. UI code OK; `safety.ts`, `gatekeeper.tsx`, `llm-proxy.ts` require diff review)
- [ ] **Read-only self-mount** *(in progress)* — agent source mounted read-only by default; self-modification requires explicit opt-in writable mount
- [ ] **Consistent mount path mirroring** *(in progress)* — mounted host paths appear at identical absolute paths inside the container to avoid agent confusion

---

## 🔭 Observability

- [ ] **Request correlation ID** — random 6–8 char hex ID per incoming user message, threaded through gatekeeper ↔ worker ↔ MCP server log lines so traces can be joined across processes
- [ ] **Log rotation / max size** — document piping `stderr` to `logrotate` or `pino-roll`; or add built-in rolling file sink to `logger.ts`
- [ ] **Tool call audit trail in session logs** — persist tool call events to the daily log so they survive context compaction and can be reviewed after the fact

---

## 🪙 Token / Cost Optimisation

- [ ] **MCP tool name shortening** — `mcp_{serverName}_{toolName}` can be long with many servers; consider a shorter/hashed prefix convention to reduce per-request token overhead
- [ ] **Tool description audit** — review all descriptions in `tools.ts`; trim any longer than ~100 tokens where the first sentence already gives the model sufficient context
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message on init to pre-warm the Anthropic prompt cache before the first real user message

---

## 🖥️ UI / UX

- [ ] **Persist conversation in browser storage** — messages and all sidebar state (toggles, model, effort level) should survive a hard reload; `localStorage` with incremental append
- [ ] **Reasoning / tool usage display** — show thinking blocks and tool calls more transparently in the UI without cluttering the main chat flow
- [ ] **Duplicate mount suppression** — if agent calls `request_mount` for a path already mounted, suppress the permission modal entirely and inject a silent context note to the agent
- [ ] **Browser extension** — read/write page DOM, manage tabs, fill forms, navigate pages; enables agentic browser automation without the overhead of a visual model
- [ ] **Browser a11y tree** — expose structured page content (labels, roles, interactive elements) via the Accessibility Object Model or Chrome DevTools Protocol; cheaper and more reliable than screenshots for understanding page structure

---

## 🤖 Computer Use / OS Automation

- [ ] **Keyboard and mouse control** — send keystrokes and mouse events to the host or sandbox display; `xdotool` / `ydotool` on Linux, `nut.js` cross-platform; prerequisite for full GUI automation
- [ ] **OS accessibility API** — enumerate windows and UI elements with their labels/roles via platform accessibility APIs (AT-SPI on Linux, NSAccessibility on macOS, UI Automation on Windows); lets the agent interact with desktop GUIs without relying on screenshots
- [ ] **Headless browser tool** — a first-class `browser` tool wrapping Playwright or Puppeteer: navigate, click, type, extract DOM/a11y tree, take screenshots; far more reliable than `fetch` + `screenshot` for multi-step web tasks
- [ ] **Application scripting** — where the OS supports it: AppleScript / JXA on macOS, COM automation on Windows; enables deep integration with desktop apps (e.g. controlling editors, terminals, mail)
- [ ] **Computer-use loop** — combine screenshot + accessibility + keyboard/mouse into a coherent "observe → decide → act" loop the agent can use for any GUI task

---

## 🔌 Extensibility & Docs

- [ ] **README: "Extending with MCP"** — document `mcp.json` format with a working example (e.g. `@modelcontextprotocol/server-github`) so contributors know how to add tools without touching core code
- [ ] **README: MCP permissions** — document the permission model once implemented
- [ ] **CONTRIBUTING.md** — explain the "run the agent and ask it to implement something" workflow; code style, PR expectations, how to add a built-in tool vs. an MCP tool

---

## 🧪 Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send a fixed message, assert a tool call is made; catches startup regressions
- [ ] **Safety unit tests** — table-driven tests for `checkExecPermission`, `validateWritePath`, `validateFetchUrl`, `validateReadonlyCommand` covering known-good, known-bad, and edge-case inputs; these are the highest-correctness-value tests in the codebase
- [ ] **Compaction round-trip test** — verify a compacted conversation can be continued without context errors or tool schema mismatches

---

## 📦 Future / Low Priority

- [ ] **Packaging / installer** — single-binary or packaged installer for non-hacker users (post-hacker-phase); consider Tauri or Electron wrapper for a desktop app
- [ ] **Multi-instance containers** — per-project agent containers once STT is decoupled from GPU requirement
- [ ] **TTS/STT one-click setup** — bundle TTS and STT startup into `make start` with graceful no-op fallback when GPU/dependencies are unavailable
- [ ] **OAT token docs** — document what an OAT token is and how to obtain one (referenced in `.env.example` but unexplained)
