# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

When the text comes streaming down the first part of the text that is actually the short answer displays and then as soon as it finishes it is wiped and then replaced by the full answer. That is quite jarring and should stop.

~~add syntax highlighting in the chat for code blocks~~ done

ON HOLD: Shall we migrate from makefile to npm commands? I'm used to makefile but it seems a bit redundant 

would be nice if when making lists in the response it added numbers by itself. Same for numbered and unnumbered lists, as soon as it detects a list. Just like google docs.

~~I should be able to pull items back from the queue to my text box~~ done

Sounds and browser notifications should be more customizible. Not really in the actual sound, but more like which sound plays: e.g. play on finish, notification on finish, same for asking for permissions, etc

the aigent just spawn a synchronous agent and I can hear popups sounds but can't see the popups, I believe that we recently fixed an issue where I was being asked for permissions where not needed. I bet that now it's still happening, it's just that the popup is not showing, and that's why I can hear the sound

## Active Bugs

~~The left panel now has horizontal scroll! Cringe!~~ fixed — added `overflow-x: hidden` to `#sidebar-panel`

- [x] ~~cancelling a message shouldn't cancel all the queue~~ — Fixed: `handleCancel()` now sets a `queueCancelled` flag that breaks the `processQueue` while loop, pausing the queue instead of immediately draining it. Queue chips are preserved and resume when the user sends a new message.

- [x] **Short mode TTS says "speak" literally** — Fixed: `stripMarkdownForTTS` now strips `<speak>` tags, and `speakText` extracts speak content before sending to TTS.

- [x] **Streaming text wipe bug** — Fixed in commit `dcda5bc`. Applied `ensureSpeakTag` during streaming `onText` callback so streamed text matches the final committed message.
- [x] **Browser ext OOM / can't-stop-on-cancel** — Fixed: propagate `browser_ext_cancel` from server through gatekeeper to ext-bridge and playwright-bridge via AbortSignal. Playwright `runScript()` now checks abort between steps. Context inspector no longer double-stringifies full base64 images (capped at 4KB preview). Screenshots compressed via `sharp` (downscale to 1568px + JPEG@80).
- [ ] **Agent iteration limits** — Sub-agents and the main agent frequently hit tool-use iteration limits mid-task. Need to investigate: better iteration budgets, auto-continuation, task decomposition strategies, or a way for agents to self-checkpoint and resume.
- [ ] **Mic speech truncation (parked)** — 5 code-level bugs identified (worklet flush, abort race, window-cap, energy gate, live timeout) but symptoms are intermittent and likely mic-hardware-dependent. Revisit if it recurs with the Razer mic. See MEMORY.md for full analysis.

---

## Security & Safety

- [ ] **Self-mod policy** — explicit allow/prompt list of paths the agent may edit autonomously vs. paths requiring diff review. Currently the agent can edit anything in `src/` and `web/src/` without approval. Should have a configurable policy for which paths get auto-approved vs. require diff review.
- [ ] **Self-mod rollback UX** — deferred until self-mod policy lands. One-click restart button, scoped `git stash` before agent edits.

---

## Token / Cost Optimisation

- [ ] **Proactive compaction** — Don't wait for 70% context usage or user-triggered `/reset`. If the conversation has grown large (e.g. 40-50k+ tokens) and the useful context can be synthesized into a compact summary, the agent should self-compact. Heuristics: long idle stretches, topic shifts, completed tasks with no follow-up. Saves significant cost on conversations that drift past usefulness.
- [ ] **Tool description audit** — trim descriptions in `src/tools/defs.ts` longer than ~100 tokens. Many tool descriptions are verbose and waste context window on every turn.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message to pre-warm the Anthropic prompt cache. First real message would then hit the cache instead of paying full input cost.
- [ ] **Compaction prompt refinement** — ensure summaries preserve file paths, bug IDs, code references. Current compaction sometimes loses specific details. See `src/compact.ts` COMPACT_PROMPT.
- [ ] **Anthropic subscription usage tracking** — display monthly usage stats from Anthropic's billing API. Local cumulative tracking exists in `src/usage-tracking.ts`; this is about pulling from the Anthropic side.

---

## UI / UX

- [x] **Edit queued messages** — Click the chip text to pull the message back into the input box. Guarded: only works when input is empty. Removes the message from the queue.
- [ ] **Undo Escape clear** — When Escape clears the input box, Ctrl+Z (or just Escape again?) should restore the previous text. Store last cleared draft and allow undo.
- [ ] **STT → ask_user integration** — When the agent asks a question (via `ask_user`), should the STT transcript go directly into the answer input? Need to figure out UX: what happens to text already in the main input box? Options: park existing draft, append, or use a separate input context for ask_user responses.

---

## Browser Automation

> Strategy: `docs/os-automation-strategy.md`. Browser-first, a11y-tree-driven, screenshot on demand.

- [ ] **Computer-use loop (deferred)** — screenshot + Anthropic computer-use API for non-browser desktop apps. Expensive fallback, low priority.

---

## Extensibility & Docs

- [ ] **CONTRIBUTING.md** — explain workflow, code style, PR expectations, how to add tools. Low priority.

---

## Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send message, assert tool call. Currently all tests are unit tests; there's no end-to-end test that starts the actual server.
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
  node --import tsx/esm --test src/reflection.test.ts  — run specific test file

Build commands:
  rm -rf web/dist && npx vite build --outDir dist web/  — rebuild web UI
  cd aigent-extension && npm run build                   — rebuild extension
```
