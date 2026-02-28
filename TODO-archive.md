# aigent — TODO Archive

Completed items moved here to keep `TODO.md` focused on active work.

---

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

## Extensibility & Docs

- [x] **README: "Extending with MCP"** — README has a full MCP section with `mcp.json` format, example GitHub server config, and tool prefixing explanation.

## Active Bugs (archived)

- [x] **Message queue drain bug** — server-side queue existed but messages queued during an agent turn (especially task result turns) were never drained. Fixed: `processAgentTurn` now kicks off `processQueue()` in its `finally` block when queued messages exist. (2026-02-28)

- [x] **Settings don't persist reliably** — thinking level was never saved to browser localStorage or synced on reconnect. Fixed: `state` events (from `/reasoning`, `/effort`, `/model`, `/short` commands and `switch_model` tool) now persist model, thinking, and short mode to `clientSettings` (localStorage). On reconnect, browser syncs saved values to server — but only when explicitly set (schema defaults don't override server env vars or autosave). (2026-02-28)

## UI Fixes (archived)

- [x] **X button always in text box** — X button is now always inside the text box, visible whenever there's text, clears mic transcript too if recording.
- [x] **Empty submit restarts mic** — empty submit now restarts mic when sticky mode is on.
- [x] **diff2html line wrapping** — diff2html code lines now use `pre-wrap` so long lines wrap instead of scrolling horizontally.
- [x] **TTS stop button + mic interrupts TTS** — (1) per-message TTSButton and `speakText` now set global `ttsPlaying` so the cancel button shows; (2) `startMic` now calls `ttsStopAll()` to interrupt TTS when user starts speaking.
