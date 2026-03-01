# aigent — TODO Archive

Completed items moved here to keep `TODO.md` focused on active work.

---

## Archived 2026-03-01

### Completed / Resolved (top-level)

- ~~HELP ME PUBLISH THIS TO NPM!~~ ✓ Published as `@stefanochiodino/aigent`
- ~~I often notice that when an agent is spawn instead of being completely asynchronous, it the agent seems to be waiting for those results and I don't quite understand why.~~ ✓ Behavioral — using dispatch_task (non-blocking) instead of spawn_agent (blocking)
- ~~The microphone often resets to the default which is incorrect and needs to be sticky to the one that I pick. Why is it so difficult?~~ ✓ Fixed — now persists device label alongside ID, re-matches by label when Chrome regenerates IDs (f764229)
- ~~keybindings should be configurable in the settings, and not just typing text, but capturing the keybindings~~ ✓ Implemented — configurable keybindings in settings with ⌨ Record capture button

### Security & Safety (completed)

- [x] **SSRF: pin curl to resolved IP** — `validateFetchUrlDns()` returns resolved IPs; curl receives `--resolve host:port:IP` flags.
- [x] **MCP server permission model** — per-server/tool allow/deny/prompt in `settings.json`.

### UI / UX (completed)

- [x] **Browser extension** — fully implemented through Phase 3c.
- [x] **Browser a11y tree** — `extract_a11y` returns structured element tree.

### Browser Automation (completed)

- [x] **Phase 3c — Destructive action heuristics** — destructive browser actions flagged with warning icon, per-action confirmation required.
- [x] **Phase 4a — CDP DevTools** — `devtools_start`/`devtools_snapshot`/`devtools_stop` actions. Attaches Chrome DevTools Protocol to capture network requests, console output, JS exceptions, and performance metrics in real time.
- [x] **Phase 4b — Context menu** — "Send to aigent" right-click menu. Selected text, links, or images are injected into the conversation as a user message.
- [x] **Phase 4c — Playwright fallback** — when the Chrome extension is not connected, browser_ext tool falls back to headless Chromium via `playwright-core`. Same action interface. Optional peer dependency (`npm install playwright-core`).

### Extensibility & Docs (completed)

- [x] **README: MCP permissions** — documented in README.md.

### Future / Low Priority (completed)

- [x] **Packaging / installer** — `npm install -g @stefanochiodino/aigent` + `aigent init` wizard. `src/xdg.ts`, `src/init.ts`, `src/cli.ts`.
- [x] **TTS/STT one-click setup** — handled by `aigent init`.

### What Was Done This Session (2026-03-01)

#### Reflection Agent — COMPLETE

Implemented `src/reflection.ts` — the cross-session pattern mining system. This is Pillar 2 of the continuous learning system (see `docs/design-continuous-learning.md`).

**What it does:**
- Runs automatically at shutdown (SIGTERM/SIGINT) and `/reset`, after `distillToMemory()`
- Loads the last 50 episodes from `workspace/episodes.ndjson`
- Asks Haiku (`claude-haiku-4-5-20251001`) to find recurring patterns — friction, success patterns, low-rated episodes, cost anomalies
- Appends actionable insights to `workspace/MEMORY.md` under `## Reflection Insights (auto-generated)`
- Appends improvement suggestions to `TODO.md` under `## Reflection-Suggested`
- Writes audit record to `workspace/reflections.ndjson`
- Skips entirely if fewer than 5 episodes exist (not enough data for patterns)
- Cost: ~$0.005 per reflection call

**Files:**
- `src/reflection.ts` — core module (~180 lines)
- `src/reflection.test.ts` — 17 unit tests (mock provider, no real LLM calls)
- `src/server.ts` — integrated into shutdown handler (after distillToMemory, before MCP shutdown)
- `src/commands.ts` — chained after distillToMemory in `/reset` handler (fire-and-forget)

**Design decisions:**
- Direct Haiku call, NOT `dispatch_task` — at shutdown the server is closing, background tasks won't complete
- Runs AFTER `distillToMemory()` — distill rewrites MEMORY.md, then reflection appends to a marked section, avoiding conflicts
- Always on — no env var or config gate (user explicitly rejected opt-in patterns)
- Minimum 5 episodes threshold prevents calling the LLM on too little data

### Continuous Learning System — Status (all phases done/deferred)

> Full design: `docs/design-continuous-learning.md`
> Implementation phases in `docs/PLAN.md` under "Continuous Learning"

| Phase | Status | Description | Files |
|-------|--------|-------------|-------|
| **1. Episode Logging** | DONE | NDJSON storage, `log_episode` + `query_episodes` tools, auto-log on reset/shutdown, domain inference, 10MB rotation | `src/episodes.ts`, 37 tests |
| **2. Reflection Agent** | DONE | Haiku-powered pattern mining at session boundaries, MEMORY.md + TODO.md updates, NDJSON audit log | `src/reflection.ts`, 17 tests |
| **3. Self-Review** | DEFERRED | Optional: agent reviews its own work via browser extension + episode history. Original two-instance self-play harness deemed over-engineered — the agent can already inspect its own UI and evaluate past performance using existing infrastructure. | — |
| **4. Feedback Collection** | DONE | UI rating widget (1-5 dots), compaction-triggered episodes, automated friction signals | `web/src/components/ChatView.tsx`, `src/server.ts`, 22 tests |
| **5. Semantic Retrieval** | DONE | Local neural embeddings (all-MiniLM-L6-v2), `search_episodes` tool, proactive retrieval, auto-indexing | `src/embeddings.ts`, `src/episode-index.ts`, 23 tests |

**Self-Review (optional, deferred):** Originally designed as a two-instance "self-play harness" where the agent would spin up a second copy and drive it via the browser. Deemed over-engineered — the agent can already inspect its own UI via the browser extension and review its own work via episode history, tool call logs, and the reflection system. If revisited, additions would be: a task library (structured prompts with eval criteria), a `/self-review` command, and tagging self-review episodes with `source: 'self-review'`.

---

## UI / UX

- [x] **Message queue chip UI** — queued messages now appear as dismissable chips above the input bar (not `[queued]` chat bubbles). Per-message cancel via ✕ button removes from server queue. New `queue_update` protocol event syncs queue state to all connected clients.

## Security & Safety

- [x] **`fetch` response size cap** — `FETCH_MAX_BYTES_HARD = 10 * 1024 * 1024` (10 MB hard ceiling) in `src/server.ts`; enforced in `src/tools/execute.ts`. Agent must request user approval to exceed the default soft limit; hard ceiling is unconditional.

- [x] **Audit log stream** — structured JSON-lines appended to `/tmp/aigent-audit.log` by `src/audit.ts`. Covers exec (tier1/2/3/user), file (read/write/block), fetch (ssrf/dns/size/allow), and MCP tool calls. Fire-and-forget; never blocks the main flow.

- [x] **SSRF DNS rebinding — DNS resolution** — `validateFetchUrlDns()` in `src/safety.ts` resolves hostnames via `dns.promises.resolve4/6` and re-checks resolved IPs against private-range regexes. Remaining gap (curl `--resolve` flag) tracked separately above.

- [x] **Safety unit tests** — 92 tests covering all functions in `src/safety.ts`; `make test` target added; pre-commit hook via `.pre-commit-config.yaml` runs typecheck + tests on every commit.
  - **Known gaps documented in tests:**
    - `mkfs *` deny glob doesn't match `mkfs.ext4 /dev/sdb` (minimatch treats `*` as not matching spaces/dots)
    - `validateReadonlyCommand` curl-pipe-to-bash bypass: splits on `|` before checking blocklist patterns

- [x] **`fetch` permission tiers**
  - Domain-based allow/prompt/deny model mirroring `ExecPermissions`. `FetchPermissions` + `checkFetchPermission()` in `src/safety.ts`; `requestFetchApproval()` in `src/server.ts`; gatekeeper handlers + `/approve-fetch` / `/deny-fetch` in `src/gatekeeper.tsx`; web UI approval modal with 🌐 icon; `--always` flag persists hostname to `settings.json` `fetch_permissions` key. 12 new unit tests.

## UI / UX

- [x] **Persist conversation in browser storage** — messages saved to `aigent_chat_history` in localStorage; restored on page load before WS connects; cleared on `/reset`.
- [x] Messages disappear on hard browser reload — fixed by localStorage persistence.

## Implemented Features (from original archive)

- Streaming responses (Anthropic/OpenAI)
- Extended thinking heuristics
- Context compaction
- Multi-provider support
- Self-modification with `tsc --noEmit` gate
- Conversation state auto-save
- Background/sync sub-agents
- 19 Core Tools (`exec`, `read_file`, `fetch`, `patch`, etc.)
- Persistent workspace memory system
- Docker sandbox with `cap_drop ALL`
- Web UI with Push-to-talk, TTS, STT, and Screen capture
- Full MCP client support
- Formal Threat Model documentation (`docs/threat-model.md`)
- Adversarial Red Team analysis (`docs/red-team.md`)

## Browser Extension / Plugin

- [x] **Phase 1 — Observe** — `browser_ext` tool with `extract_a11y` + `screenshot`. Extension in `aigent-extension/`, bridge in `src/ext-bridge.ts`, gatekeeper `/ext` WebSocket in `src/web-bridge.ts`.
- [x] **Phase 2 — Write** — `run_script` + `navigate` actions with batched steps (fill, click, scroll, wait, pressKey, etc.); gatekeeper approval gate + web UI permission modal (`browser_write_request`). (2026-02-26)
- [x] **Phase 3a — Multi-tab + grants** — `activate_tab` (switch tab focus), `open_tab` (new tab), session-level `browser.write` grant via `--always` flag and "Always Allow" button in permission modal. (2026-02-26)
- [x] **MCP tool name shortening** — investigated, closed as won't-fix. Savings <0.3% of context, prompt caching already mitigates cost, LLM semantic degradation risk outweighs benefit. See `docs/mcp-tool-shortening.md`.
- [x] **Attached images persist in chat** — thumbnails generated client-side, stored in `DisplayMessage.attachments`, rendered in `Message.tsx`, persisted via Zustand localStorage. See `docs/image-handling.md`.
- [x] **Agent spawn details** — model name and reasoning level shown in the expandable details panel of `spawn_agent` and `dispatch_task` tool traces.
- [x] **Phase 3b — Autonomous mode + close_tab** — `browser.autonomous` grant (distinct from `browser.write`), `close_tab` action, "Go Autonomous" button in permission modal. Destructive action heuristics deferred. (2026-02-26)
- [x] **Phase 3c — Destructive action heuristics** — `DESTRUCTIVE_PATTERNS` regex list (submit, delete, purchase, etc.) checks click targets and navigate URLs. Even with `browser.write` granted, destructive actions require per-action confirmation (unless `browser.autonomous` active). Warning icon in permission modal, "Always Allow" hidden for destructive requests. (2026-02-28)
- [x] **Extension authentication** — shared secret via `crypto.randomUUID()`, served at `GET /ext/secret`, validated on WebSocket upgrade via query param. Extension re-fetches secret on each reconnect. (2026-02-28)
- [x] **SSRF validation for navigate URLs** — `validateFetchUrl()` applied to navigate, open_tab, and run_script navigate steps. Blocks private IPs, localhost, cloud metadata. (2026-02-28)
- [x] **Browser extension audit logging** — `browser_ext_read`, `browser_ext_write_grant`, `browser_ext_write_prompt`, `browser_ext_user_approve`, `browser_ext_user_deny`, `browser_ext_destructive_prompt`, `browser_ext_ssrf_block` event types in audit log. (2026-02-28)
- [x] **Extension connection indicator** — sidebar Capabilities section shows "Browser" with green "on" badge when Chrome extension is connected. `host_state` event carries `extensionConnected` flag. (2026-02-28)
- [x] **Mid-script screenshot step** — `{ screenshot: true }` step type in `run_script`. Background worker captures via `captureVisibleTab` (pause-resume pattern like navigation). Screenshots returned as image content blocks. (2026-02-28)

## Extensibility & Docs

- [x] **README: "Extending with MCP"** — README has a full MCP section with `mcp.json` format, example GitHub server config, and tool prefixing explanation.

## Active Bugs (archived)

- [x] **Message queue drain bug** — server-side queue existed but messages queued during an agent turn (especially task result turns) were never drained. Fixed: `processAgentTurn` now kicks off `processQueue()` in its `finally` block when queued messages exist. (2026-02-28)

- [x] **Settings don't persist reliably** — thinking level was never saved to browser localStorage or synced on reconnect. Fixed: `state` events (from `/reasoning`, `/effort`, `/model`, `/short` commands and `switch_model` tool) now persist model, thinking, and short mode to `clientSettings` (localStorage). On reconnect, browser syncs saved values to server — but only when explicitly set (schema defaults don't override server env vars or autosave). (2026-02-28)

- [x] **Reasoning toggle on incompatible models** — toggle and effort pills now disabled with hint when current model isn't Opus. (2026-02-28)

- [x] **TraceInspector not wired up** — mounted in App.tsx via createPortal; TraceBlock expanded body now opens the inspector on click. Store state already existed. (2026-02-28)

## UI Fixes (archived)

- [x] **X button always in text box** — X button is now always inside the text box, visible whenever there's text, clears mic transcript too if recording.
- [x] **Empty submit restarts mic** — empty submit now restarts mic when sticky mode is on.
- [x] **diff2html line wrapping** — diff2html code lines now use `pre-wrap` so long lines wrap instead of scrolling horizontally.
- [x] **TTS stop button + mic interrupts TTS** — (1) per-message TTSButton and `speakText` now set global `ttsPlaying` so the cancel button shows; (2) `startMic` now calls `ttsStopAll()` to interrupt TTS when user starts speaking.
