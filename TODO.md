# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

## Bugs / Quick Fixes

- [x] **Attached images should persist in chat** — thumbnails generated client-side, stored in `DisplayMessage.attachments`, rendered in `Message.tsx`, persisted via Zustand localStorage. See `docs/image-handling.md` and `docs/implementation/2026-02-24-image-persistence.md`.
- [ ] **Agent spawn details** — show model name and reasoning mode in the spawned-agent details panel.
- [ ] **Reasoning toggle on incompatible models** — UI allows enabling reasoning on models that don't support it (e.g. Haiku); disable the toggle or warn.
- [ ] **Duplicate mount suppression** — agent sometimes re-requests an already-active mount; gatekeeper should auto-approve redundant requests silently.

---

## 🔒 Security & Safety

- [ ] **Harden SSRF protection against DNS rebinding**
  - Use `dns.promises.lookup` in `validateFetchUrl` to resolve the hostname.
  - Run private-IP regex checks against the *resolved IP*, not the hostname.
  - Pass `--resolve` flag to `curl` to pin the IP.

- [ ] **`fetch` response size cap** — hard limit (e.g. 10 MB) to prevent large-payload exfiltration or OOM.

- [ ] **`host.open` default to prompt** — add domain/scheme policy (block `file://`, `javascript:`, non-HTTPS).

- [ ] **MCP server permission model** — optional `permissions` block per server in `mcp.json`; default: `prompt` for all calls.

- [ ] **Self-mod policy** — explicit allow/prompt list of paths the agent may edit autonomously vs. paths requiring diff review.

- [ ] **Self-mod rollback UX** — revisit when self-mod policy lands. Deferred: one-click restart button, scoped `git stash` before agent edits.

- [ ] **Read-only self-mount** — agent source mounted read-only by default; self-mod requires explicit opt-in writable mount.

- [ ] **Consistent mount path mirroring** — host paths appear at identical absolute paths inside the container.

---

## 🔭 Observability

- [ ] **Request correlation ID (`reqId`)** — thread a 6-char hex ID through UI → Gatekeeper → Sandbox → Sub-agents → MCP.
- [ ] **Audit log stream** — structured `[AUDIT]` entries to a dedicated rotating file for mount approvals, exec/fetch permissions, config writes, startup.
- [ ] **Log rotation / max size** — pipe `stderr` to `logrotate` / `pino-roll`, or rolling file sinks in the logger.
- [ ] **Tool call audit trail in session logs** — persist tool call events to daily log so they survive context compaction.

---

## 🪙 Token / Cost Optimisation

- [ ] **MCP tool name shortening** — consider shorter/hashed prefix to reduce per-request token overhead.
- [ ] **Tool description audit** — trim descriptions in `tools.ts` longer than ~100 tokens.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message to pre-warm the Anthropic cache.
- [ ] **Compaction prompt refinement** — ensure summaries preserve file paths, bug IDs, code references.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats (tokens, cost) from Anthropic API.

---

## 🖥️ UI / UX

- [ ] **Reasoning / tool usage display** — show thinking blocks and tool calls more transparently without cluttering chat.
- [ ] **Browser extension** — read/write page DOM, manage tabs, fill forms, navigate; agentic browser automation without visual model overhead.
- [ ] **Browser a11y tree** — expose structured page content via AOM or CDP; cheaper than screenshots for understanding page structure.

---

## 🤖 Computer Use / OS Automation

- [ ] **Headless browser tool** — Playwright or MCP Server wrapper. See `docs/design-headless-browser.md`.
- [ ] **Keyboard and mouse control** — `xdotool`/`ydotool` on Linux, `nut.js` cross-platform.
- [ ] **OS accessibility API** — AT-SPI (Linux), NSAccessibility (macOS), UI Automation (Windows).
- [ ] **Application scripting** — AppleScript/JXA (macOS), COM automation (Windows).
- [ ] **Computer-use loop** — screenshot + accessibility + keyboard/mouse in an observe → decide → act loop.

---

## 🔌 Extensibility & Docs

- [ ] **README: "Extending with MCP"** — document `mcp.json` format with a working example.
- [ ] **README: MCP permissions** — document permission model once implemented.
- [ ] **CONTRIBUTING.md** — explain workflow, code style, PR expectations, how to add tools.

---

## 🧪 Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send message, assert tool call.
- [ ] **Compaction round-trip test** — verify compacted conversation can continue without errors.

---

## 📦 Future / Low Priority

- [ ] **Packaging / installer** — single-binary or packaged installer; consider Tauri or Electron.
- [ ] **Multi-instance containers** — per-project agent containers once STT is decoupled from GPU.
- [ ] **TTS/STT one-click setup** — bundle into `make start` with graceful fallback.
- [ ] **OAT token docs** — document what an OAT token is and how to obtain one.
