# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

ON HOLD: Shall we migrate from makefile to npm commands? I'm used to makefile but it seems a bit redundant

~~Sounds and browser notifications should be more customizable. Not really in the actual sound, but more like which sound plays: e.g. play on finish, notification on finish, same for asking for permissions, etc~~ done — 4 toggles in Settings → Notifications: sound on permission (on by default, now toggleable), sound on response complete, browser notification on permission, browser notification on response complete

~~the aigent just spawn a synchronous agent and I can hear popups sounds but can't see the popups~~ investigated — gatekeeper-first architecture already prevents phantom permission sounds for exec and file_access requests; no reproducible code path found

the model picker on the left bar shows stars but doesn't allow to favourite/unfavourite.

## Active Bugs

- [ ] **Agent iteration limits** — Sub-agents and the main agent frequently hit tool-use iteration limits mid-task. Need to investigate: better iteration budgets, auto-continuation, task decomposition strategies, or a way for agents to self-checkpoint and resume.
- [ ] **Mic speech truncation (parked)** — 5 code-level bugs identified (worklet flush, abort race, window-cap, energy gate, live timeout) but symptoms are intermittent and likely mic-hardware-dependent. Revisit if it recurs with the Razer mic. See MEMORY.md for full analysis.

---

## Vision Feature (Parked)
- [ ] Wire up `onVisionUnsupported` callback in server.ts
- [ ] Broadcast `modelsWithoutVision` in state
- [ ] Add actual image stripping logic when retrying
- [ ] Add unit tests

## VSCode Integration
- [ ] Explore VSCode extension possibilities
- [ ] Implement CLI commands for VSCode extension to call

---

## Security & Safety

- [ ] **Self-mod policy** — explicit allow/prompt list of paths the agent may edit autonomously vs. paths requiring diff review. Currently the agent can edit anything in `src/` and `web/src/` without approval. Should have a configurable policy for which paths get auto-approved vs. require diff review.
- [ ] **Self-mod rollback UX** — deferred until self-mod policy lands. One-click restart button, scoped `git stash` before agent edits.

---

## Token / Cost Optimisation

- [x] **Tool description audit** — trimmed all 24 tool descriptions to ≤100 chars each. Saved ~730 chars (~183 tokens) from tool definitions.
- [x] **Proactive compaction** — LLM-driven: context usage stats injected into system prompt, `compact_context` tool lets the agent decide when to compact based on content relevance (not just threshold). Aggressiveness auto-scales with usage %. Post-response auto-compact at 85% removed; pre-send 80% safety net and 413 fallback retained as guardrails.
- [x] **Compaction prompt refinement** — moderate and aggressive prompts now explicitly request file paths with line numbers, function/variable names, error messages, numeric values, and tool call outcomes.
- [x] **Adaptive compaction aggressiveness** — `compact()` now takes an aggressiveness parameter. Light at 80% (keeps 4 turns), moderate at 85% (keeps 2), aggressive on 413 (keeps 1).
- [x] **Workspace context string caching** — `loadWorkspaceContext()` caches the assembled string and returns it immediately when no source files changed. `/refresh` invalidates the cache.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats from Anthropic's billing API. Local cumulative tracking exists in `src/usage-tracking.ts`; this is about pulling from the Anthropic side.

---

## UI / UX

- [x] **Undo Escape clear** — Escape again (or Escape after ✕ button) restores the last cleared draft. Toggle behavior: Escape clears → Escape restores → Escape clears.
- [x] **STT → ask_user integration** — Single `useMic` instance in InputArea with focus-based routing. Mic button on the QuestionForm textarea with identical styling (recording/transcribing/VAD states). Click the question textarea or its mic button → STT goes there; click the main input → STT routes back. Typing during dictation calls `commitBase` so user edits are preserved.

---

## Browser Automation

> Strategy: `docs/os-automation-strategy.md`. Browser-first, a11y-tree-driven, screenshot on demand.

- [ ] **Computer-use loop (deferred)** — screenshot + Anthropic computer-use API for non-browser desktop apps. Expensive fallback, low priority.

---

## Extensibility & Docs

- [ ] **CONTRIBUTING.md** — explain workflow, code style, PR expectations, how to add tools. Low priority.

---

## Testing

- [x] **Integration smoke test** — `make test-llm` runs a real conversation loop against a local LLM (Ollama). Auto-starts Ollama, pulls a model if needed, verifies text response + tool call round-trip. Configurable model and context window for different hardware.
- [ ] **Compaction round-trip test** — verify compacted conversation can continue without errors. Unit tests exist in `compact.test.ts`; this is an end-to-end continuation test.

---

## Future / Low Priority

- [ ] **Multi-instance agents** — per-project agent processes once STT is decoupled from GPU.
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
  make test-llm       — integration test with local LLM (Ollama, on demand)
  node --import tsx/esm --test src/reflection.test.ts  — run specific test file

Build commands:
  rm -rf web/dist && npx vite build --outDir dist web/  — rebuild web UI
  cd aigent-extension && npm run build                   — rebuild extension
```

---

## Reflection-Suggested

- [ ] **API error handling framework** — Implement centralized error handling for 400 (token limits), 402 (credits), 429 (overloaded) errors with automatic retries and user notifications
- [ ] **GitHub Pages deployment automation** — Add pre-commit hook to verify commits are pushed before deploying, or implement automatic push+deploy workflow
- [ ] **Context-aware task dispatch** — Build logic to automatically choose dispatch_task vs spawn_agent based on task complexity and whether result is needed immediately
- [ ] **Model ID validation** — Add validation for model identifiers before API calls to prevent 400 errors from invalid model IDs
- [ ] **Permission timeout handling** — Implement retry logic for request_config_write and host_edit_file approvals that time out at 120s
- [ ] **Message sync monitoring** — Add monitoring for uiMessages vs agentMessages sync issues when user reports 'messages being lost'
- [ ] **Project naming in reports** — Always name the project explicitly when reporting background task results to disambiguate when user has multiple threads running
