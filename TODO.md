# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

## Active Bugs

- [ ] **Queued message lost on cancel** — if a message is queued and the agent's run is cancelled, the queued message is silently dropped. The whole queue → cancel → resume chain feels brittle and needs a reliability pass.

- [ ] **Queued message UX** — queued messages should look better than `[Q'd]` and stick to the bottom above the input bar (not inside the chat), similar to Cursor.

- [ ] **Settings don't persist reliably** — model, short mode, and other settings seem to reset. They should persist hard across sessions.

## Bugs / Quick Fixes

- [ ] **Reasoning toggle on incompatible models** — UI allows enabling reasoning on models that don't support it (e.g. Haiku); disable the toggle or warn.

---

## Security & Safety

- [ ] **Harden SSRF protection against DNS rebinding**
  - Use `dns.promises.lookup` in `validateFetchUrl` to resolve the hostname.
  - Run private-IP regex checks against the *resolved IP*, not the hostname.
  - Pass `--resolve` flag to `curl` to pin the IP.

- [ ] **`fetch` response size cap** — hard limit (e.g. 10 MB) to prevent large-payload exfiltration or OOM.

- [ ] **MCP server permission model** — optional `permissions` block per server in `mcp.json`; default: `prompt` for all calls.

- [ ] **Self-mod policy** — explicit allow/prompt list of paths the agent may edit autonomously vs. paths requiring diff review.

- [ ] **Self-mod rollback UX** — revisit when self-mod policy lands. Deferred: one-click restart button, scoped `git stash` before agent edits.

---

## Observability

- [ ] **Request correlation ID (`reqId`)** — thread a 6-char hex ID through UI → Gatekeeper → Agent → Sub-agents → MCP.
- [ ] **Audit log stream** — structured `[AUDIT]` entries to a dedicated rotating file for exec/fetch permissions, config writes, startup.
- [ ] **Log rotation / max size** — pipe `stderr` to `logrotate` / `pino-roll`, or rolling file sinks in the logger.
- [ ] **Tool call audit trail in session logs** — persist tool call events to daily log so they survive context compaction.

---

## Token / Cost Optimisation

- [ ] **Tool description audit** — trim descriptions in `tools.ts` longer than ~100 tokens.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message to pre-warm the Anthropic cache.
- [ ] **Compaction prompt refinement** — ensure summaries preserve file paths, bug IDs, code references.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats (tokens, cost) from Anthropic API.

---

## UI / UX

- [ ] **Reasoning / tool usage display** — show thinking blocks and tool calls more transparently without cluttering chat.
- [ ] **Browser extension** — see `docs/design-browser-extension.md` for full design. Live session automation (already logged in), a11y-tree-driven, batched action scripts, gatekeeper-bridged.
- [ ] **Browser a11y tree** — covered in extension design; `extract_a11y` returns structured element tree, ~800–2000 tokens vs ~20k for raw HTML.

---

## Browser Automation (Primary OS Presence Track)

> Strategy decided — see `docs/os-automation-strategy.md`. Browser-first, a11y-tree-driven, screenshot on demand.
> Native OS APIs (AT-SPI, UIA, NSAccessibility) deferred — too platform-fragmented, broken in WSL2.

- [ ] **Phase 3c — Destructive action heuristics** — detect and confirm destructive click targets (submit, delete, purchase, etc.) even when `browser.write` is granted; only skipped by `browser.autonomous`
- [ ] **Headless browser (deferred)** — Playwright fallback for unattended/CI runs. See `docs/design-headless-browser.md`.
- [ ] **Computer-use loop (deferred)** — screenshot + Anthropic computer-use API for non-browser desktop apps; expensive fallback only

---

## Extensibility & Docs

- [ ] **README: "Extending with MCP"** — document `mcp.json` format with a working example.
- [ ] **README: MCP permissions** — document permission model once implemented.
- [ ] **CONTRIBUTING.md** — explain workflow, code style, PR expectations, how to add tools.

---

## Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send message, assert tool call.
- [ ] **Compaction round-trip test** — verify compacted conversation can continue without errors.

---

## Future / Low Priority

- [ ] **Packaging / installer** — single-binary or packaged installer; consider Tauri or Electron.
- [ ] **Multi-instance agents** — per-project agent processes once STT is decoupled from GPU.
- [ ] **TTS/STT one-click setup** — bundle into `make start` with graceful fallback.
- [ ] **OAT token docs** — document what an OAT token is and how to obtain one.
