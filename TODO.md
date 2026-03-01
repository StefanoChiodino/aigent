# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

~~HELP ME PUBLISH THIS TO NPM!~~ ✓ Published as `@stefanochiodino/aigent`

---

## Active Bugs

(none currently)

---

## What Was Done This Session (2026-03-01)

### Reflection Agent — COMPLETE

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

---

## Continuous Learning System — Status

> Full design: `docs/design-continuous-learning.md`
> Implementation phases in `docs/PLAN.md` under "Continuous Learning"

| Phase | Status | Description | Files |
|-------|--------|-------------|-------|
| **1. Episode Logging** | DONE | NDJSON storage, `log_episode` + `query_episodes` tools, auto-log on reset/shutdown, domain inference, 10MB rotation | `src/episodes.ts`, 37 tests |
| **2. Reflection Agent** | DONE | Haiku-powered pattern mining at session boundaries, MEMORY.md + TODO.md updates, NDJSON audit log | `src/reflection.ts`, 17 tests |
| **3. Self-Play Harness** | NOT STARTED | Launch isolated test instance, drive via browser extension, evaluate results | Design in `docs/design-continuous-learning.md` §Pillar 2 |
| **4. Feedback Collection** | DONE | UI rating widget (1-5 dots), compaction-triggered episodes, automated friction signals | `web/src/components/ChatView.tsx`, `src/server.ts`, 22 tests |
| **5. Semantic Retrieval** | DONE | Local neural embeddings (all-MiniLM-L6-v2), `search_episodes` tool, proactive retrieval, auto-indexing | `src/embeddings.ts`, `src/episode-index.ts`, 23 tests |

### Self-Play Harness (the remaining piece)

This is the most complex continuous learning piece. The agent spins up a second instance of itself, gives it tasks through the browser, and evaluates the results. Infrastructure mostly exists already (browser extension, port isolation, profiles for workspace isolation, `dispatch_task` for async evaluation).

**What's needed:**
1. Script to launch an isolated test instance on a different port (e.g., 3142) with a clean workspace
2. Task library format: structured records with prompt, setup script, eval criteria
3. Supervisor loop: load task → send to test instance via browser → wait for completion → evaluate
4. Episode logging for self-play results (same Episode schema, tagged with `source: 'self-play'`)
5. Initial task library (5-10 tasks covering bug finding, code generation, debugging, writing, research)

**Complexity:** HIGH — involves process management, browser automation coordination, evaluation criteria, and cost management. May want to defer or simplify (e.g., start with CLI-only tasks that don't need the browser).

---

## Security & Safety

- [x] **SSRF: pin curl to resolved IP** — `validateFetchUrlDns()` returns resolved IPs; curl receives `--resolve host:port:IP` flags.
- [x] **MCP server permission model** — per-server/tool allow/deny/prompt in `settings.json`.
- [ ] **Self-mod policy** — explicit allow/prompt list of paths the agent may edit autonomously vs. paths requiring diff review. Currently the agent can edit anything in `src/` and `web/src/` without approval. Should have a configurable policy for which paths get auto-approved vs. require diff review.
- [ ] **Self-mod rollback UX** — deferred until self-mod policy lands. One-click restart button, scoped `git stash` before agent edits.

---

## Token / Cost Optimisation

- [ ] **Tool description audit** — trim descriptions in `src/tools/defs.ts` longer than ~100 tokens. Many tool descriptions are verbose and waste context window on every turn.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message to pre-warm the Anthropic prompt cache. First real message would then hit the cache instead of paying full input cost.
- [ ] **Compaction prompt refinement** — ensure summaries preserve file paths, bug IDs, code references. Current compaction sometimes loses specific details. See `src/compact.ts` COMPACT_PROMPT.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats from Anthropic's billing API. Local cumulative tracking exists in `src/usage-tracking.ts`; this is about pulling from the Anthropic side.

---

## UI / UX

- [x] **Browser extension** — fully implemented through Phase 3c.
- [x] **Browser a11y tree** — `extract_a11y` returns structured element tree.

---

## Browser Automation

> Strategy: `docs/os-automation-strategy.md`. Browser-first, a11y-tree-driven, screenshot on demand.

- [x] **Phase 3c — Destructive action heuristics** — destructive browser actions flagged with warning icon, per-action confirmation required.
- [ ] **Headless browser (deferred)** — Playwright fallback for unattended/CI runs. Design doc: `docs/design-headless-browser.md`. Not urgent until self-play or CI testing requires it.
- [ ] **Computer-use loop (deferred)** — screenshot + Anthropic computer-use API for non-browser desktop apps. Expensive fallback, low priority.

---

## Extensibility & Docs

- [x] **README: MCP permissions** — documented in README.md.
- [ ] **CONTRIBUTING.md** — explain workflow, code style, PR expectations, how to add tools. Low priority.

---

## Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send message, assert tool call. Currently all tests are unit tests; there's no end-to-end test that starts the actual server.
- [ ] **Compaction round-trip test** — verify compacted conversation can continue without errors. Unit tests exist in `compact.test.ts`; this is an end-to-end continuation test.

---

## Future / Low Priority

- [x] **Packaging / installer** — `npm install -g @stefanochiodino/aigent` + `aigent init` wizard. `src/xdg.ts`, `src/init.ts`, `src/cli.ts`.
- [ ] **Multi-instance agents** — per-project agent processes once STT is decoupled from GPU.
- [x] **TTS/STT one-click setup** — handled by `aigent init`.
- [ ] **OAT token docs** — document what an OAT token is and how to obtain one.
- [ ] **PWA manifest + service worker** — installable mobile app.
- [ ] **Conversation search** — `/search <term>` across past sessions.
- [ ] **Better image UX** — drag-and-drop paths, URL fetch.

---

## Architecture Quick Reference

```
Key source files for common tasks:

Agent core:        src/agent.ts, src/server.ts, src/provider.ts
Tools:             src/tools/defs.ts (definitions), src/tools/execute.ts (execution)
Safety:            src/safety.ts, src/gatekeeper.tsx
Web UI:            web/src/app.ts, web/src/components/
Memory:            src/workspace.ts, src/compact.ts
Episodes:          src/episodes.ts, src/episode-index.ts, src/embeddings.ts
Reflection:        src/reflection.ts
Browser ext:       aigent-extension/
Commands:          src/commands.ts
Profiles:          src/profiles.ts
Background tasks:  src/tasks.ts

Test commands:
  make check          — typecheck + unit tests + web tests + builds
  node --import tsx/esm --test src/reflection.test.ts  — run specific test file

Build commands:
  rm -rf web/dist && npx vite build --outDir dist web/  — rebuild web UI
  cd aigent-extension && npm run build                   — rebuild extension
```
