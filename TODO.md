# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

## Bugs / Quick Fixes

- [x] **Attached images should persist in chat** — thumbnails generated client-side, stored in `DisplayMessage.attachments`, rendered in `Message.tsx`, persisted via Zustand localStorage. See `docs/image-handling.md` and `docs/implementation/2026-02-24-image-persistence.md`.
- [x] **Agent spawn details** — model name and reasoning level shown in the expandable details panel of `spawn_agent` and `dispatch_task` tool traces. Model shortened (e.g. `sonnet 4.6`), reasoning hidden when `off`. See `tests/specs/34-agent-spawn-details.spec.ts`.
- [ ] **Reasoning toggle on incompatible models** — UI allows enabling reasoning on models that don't support it (e.g. Haiku); disable the toggle or warn.
- [ ] **Duplicate mount suppression** — agent sometimes re-requests an already-active mount; gatekeeper should auto-approve redundant requests silently.

### Extension Sidepanel Bugs — RESOLVED
> Sidepanel replaced with popup window (`chrome.windows.create`). All sidepanel
> bugs eliminated — no iframe, no mic relay, no BroadcastChannel, no `isSidepanel`
> branches. See `docs/web-ui-architecture.md`. (2026-02-25)

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

- [x] **MCP tool name shortening** — investigated, closed as won't-fix. Savings <0.3% of context, prompt caching already mitigates cost, LLM semantic degradation risk outweighs benefit. See `docs/mcp-tool-shortening.md`.
- [ ] **Tool description audit** — trim descriptions in `tools.ts` longer than ~100 tokens.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message to pre-warm the Anthropic cache.
- [ ] **Compaction prompt refinement** — ensure summaries preserve file paths, bug IDs, code references.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats (tokens, cost) from Anthropic API.

---

## 🖥️ UI / UX

- [ ] **Reasoning / tool usage display** — show thinking blocks and tool calls more transparently without cluttering chat.
- [ ] **Browser extension** — see `docs/design-browser-extension.md` for full design. Live session automation (already logged in), a11y-tree-driven, batched action scripts, gatekeeper-bridged.
- [ ] **Browser a11y tree** — covered in extension design; `extract_a11y` returns structured element tree, ~800–2000 tokens vs ~20k for raw HTML.

---

## 🤖 Browser Automation (Primary OS Presence Track)

> Strategy decided — see `docs/os-automation-strategy.md`. Browser-first, a11y-tree-driven, screenshot on demand.
> Native OS APIs (AT-SPI, UIA, NSAccessibility) deferred — too platform-fragmented, broken in WSL2.

- [x] **Phase 1 — Observe (shipped)** — `browser_ext` tool with `extract_a11y` + `screenshot`. Extension in `aigent-extension/`, bridge in `src/ext-bridge.ts`, gatekeeper `/ext` WebSocket in `src/web-bridge.ts`. Build: `npm run ext:build`. Load from `aigent-extension/dist/` in Chrome.
- [ ] **Phase 2 — Write** — `run_script` action with batched steps (fill, click, navigate, scroll, wait); write permission grant UI in web UI (same pattern as exec/mount approval)
- [ ] **Phase 3 — Multi-tab/navigation** — tab enumeration, cross-page flows, `browser.autonomous` grant
- [ ] **Headless browser (deferred)** — Playwright fallback for unattended/CI runs. See `docs/design-headless-browser.md`.
- [ ] **Computer-use loop (deferred)** — screenshot + Anthropic computer-use API for non-browser desktop apps; expensive fallback only

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
