# aigent — TODO

> Completed items archived in [TODO-archive.md](TODO-archive.md).

coincise mode seems to start often saying literally " slash speech"

~~Move the X button to clear the text input as a permanent feature that doesn't go away, right next to the text box. It should work in all context, with or without the always on recording.~~ **Fixed** — X button is now always inside the text box, visible whenever there's text, clears mic transcript too if recording.

~~If there is nothing in the text box and I start the microphone and then send the the message which is empty, it will disable the microphone but keep the always on turn on.~~ **Fixed** — empty submit now restarts mic when sticky mode is on.

If I queue a message and then I cancel the agent's running, my message looks queued, but it doesn't uh get picked up at all. I'm finding a lot of these type of bugs and to be honest it is getting pretty annoying to the point where I wanted to have a look at the whole chain of events where it should be a straightforward type of cue that allows to send these things and then can cancel them, etcetera. This seems very, very brittle.

Queued messages should look a little bit prettier, just putting Q'd in brackets, it doesn't look terribly pretty, and also they should stick to the bottom uh just above the bar where I type instead of going inside the chat because they haven't been picked up yet. A little bit like it works in cursor, for example.

I keep feeling finding over and over and over again that the models, the coin size mode, and various other things seems to change. They should persist very hard. I really don't know why this is a problem.

~~In the div2 HTML we should probably when a patch model is presented uh show up something to wrap the text instead of having it progress horizontally.~~ **Fixed** — diff2html code lines now use `pre-wrap` so long lines wrap instead of scrolling horizontally.

Despite having a folder mounted the agent just uh um proceeded to present me with a patch. Is the order of priority clear, do you think, to the agent? I'm not sure why they're getting confused with presenting me with a patch rather than writing directly to the disc.

~~After reply, I looked and there was no stop button to make the agent stop talking. Also I had the always a microphone on and as I started talking it didn't stop talking.~~ **Fixed** — (1) per-message TTSButton and `speakText` now set global `ttsPlaying` so the cancel button shows; (2) `startMic` now calls `ttsStopAll()` to interrupt TTS when user starts speaking.


## Bugs / Quick Fixes

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

- [x] **Phase 3b — Autonomous mode + close_tab** — `browser.autonomous` grant (distinct from `browser.write`), `close_tab` action, "Go Autonomous" button in permission modal. Destructive action heuristics deferred. (2026-02-26)
- [ ] **Phase 3c — Destructive action heuristics** — detect and confirm destructive click targets (submit, delete, purchase, etc.) even when `browser.write` is granted; only skipped by `browser.autonomous`
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
