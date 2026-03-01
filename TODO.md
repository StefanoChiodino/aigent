# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

## Active Bugs

(none currently)

## Bugs / Quick Fixes

(none currently)

---

## Security & Safety

- [x] **SSRF: pin curl to resolved IP** — `validateFetchUrlDns()` now returns resolved IPs; curl receives `--resolve host:port:IP` flags to close the TOCTOU window.

- [x] **MCP server permission model** — per-server/tool allow/deny/prompt in `settings.json` (`mcp_permissions`); "Always Allow" button in modal; audit logging; settings UI.

- [ ] **Self-mod policy** — explicit allow/prompt list of paths the agent may edit autonomously vs. paths requiring diff review.

- [ ] **Self-mod rollback UX** — revisit when self-mod policy lands. Deferred: one-click restart button, scoped `git stash` before agent edits.

---

## Observability

- [x] **Request correlation ID (`reqId`)** — 6-char hex ID threaded through UI → Web bridge → Server (AsyncLocalStorage) → Agent → Sub-agents → MCP (`_meta.reqId`). Logger and audit log auto-read from context.
- [x] **Log rotation / max size** — `rotateIfNeeded()` runs at startup for gatekeeper log and audit log. 5 MB threshold, 2 rotations kept.
- [x] **Tool call audit trail in session logs** — `onToolComplete` callback in agent.ts appends pipe-delimited entries to `workspace/memory/YYYY-MM-DD.md` via `appendToolLog()`.

---

## Token / Cost Optimisation

- [ ] **Tool description audit** — trim descriptions in `tools.ts` longer than ~100 tokens.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message to pre-warm the Anthropic cache.
- [ ] **Compaction prompt refinement** — ensure summaries preserve file paths, bug IDs, code references.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats (tokens, cost) from Anthropic API. (Local cumulative tracking exists in `src/usage-tracking.ts`; this is about fetching from Anthropic's billing API.)

---

## UI / UX

- [x] **Browser extension** — fully implemented through Phase 3c. Live session automation, a11y-tree-driven, batched action scripts, gatekeeper-bridged. Extension auth (shared secret), SSRF validation on navigate, destructive action heuristics, audit logging, sidebar connection indicator, mid-script screenshot steps.
- [x] **Browser a11y tree** — `extract_a11y` returns structured element tree (~800–2000 tokens), inline `extractA11y` and `screenshot` steps available mid-script.

---

## Browser Automation (Primary OS Presence Track)

> Strategy decided — see `docs/os-automation-strategy.md`. Browser-first, a11y-tree-driven, screenshot on demand.
> Native OS APIs (AT-SPI, UIA, NSAccessibility) deferred — too platform-fragmented, broken in WSL2.

- [x] **Phase 3c — Destructive action heuristics** — destructive browser actions flagged with warning icon, "Always Allow" hidden, per-action confirmation required; skipped by `browser.autonomous`
- [ ] **Headless browser (deferred)** — Playwright fallback for unattended/CI runs. See `docs/design-headless-browser.md`.
- [ ] **Computer-use loop (deferred)** — screenshot + Anthropic computer-use API for non-browser desktop apps; expensive fallback only

---

## Extensibility & Docs

- [x] **README: MCP permissions** — documented in README.md under MCP section.
- [ ] **CONTRIBUTING.md** — explain workflow, code style, PR expectations, how to add tools.

---

## Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send message, assert tool call.
- [ ] **Compaction round-trip test** — verify compacted conversation can continue without errors. (Unit tests exist in `compact.test.ts`; this is an end-to-end continuation test.)

---

## Continuous Learning (new track — see `docs/design-continuous-learning.md`)

- [x] **Episode logging** — `src/episodes.ts`: Episode interface, NDJSON storage (`workspace/episodes.ndjson`), `log_episode` + `query_episodes` tools, auto-log on `/reset` and shutdown, domain inference, session tracking, 10MB rotation. 37 unit tests.
- [ ] **Reflection agent** — background agent at session end: extracts structured episodes, mines patterns across recent history, proposes improvements (MEMORY.md updates, TODO items, auto-fixes).
- [ ] **Self-play harness** — launch isolated test instance (different port, clean workspace), drive via browser extension, evaluate results. Task library format: prompt + setup script + eval criteria.
- [x] **Feedback collection** — three-channel system: (1) UI rating widget (1-5 dots on each assistant message), (2) compaction-triggered episode boundaries (`auto-compact` source), (3) automated friction signals (tool failures, API errors tracked per session). Ratings averaged into `userRating` on episodes. System prompt instructs agent to call `log_episode` at natural breaks. 13 web tests, 9 new episode tests.
- [ ] **Semantic episode retrieval** — embeddings over episode summaries (local model or Anthropic voyage + SQLite-vec). Proactive surfacing of relevant past experience before starting similar tasks.

---

## Future / Low Priority

- [ ] **Packaging / installer** — single-binary or packaged installer; consider Tauri or Electron.
- [ ] **Multi-instance agents** — per-project agent processes once STT is decoupled from GPU.
- [ ] **TTS/STT one-click setup** — bundle into `make start` with graceful fallback.
- [ ] **OAT token docs** — document what an OAT token is and how to obtain one.
