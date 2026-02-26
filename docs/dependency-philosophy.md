# Dependency Philosophy

This document records deliberate decisions about which npm packages to use and which custom implementations to keep. Updated after a full audit in February 2026.

---

## Guiding principle

Lock-in risk matters more than line count. A 500-line custom implementation that we fully understand and can fix in an hour is often better than a 50-line wrapper around a package that breaks its API between major versions, has its own ecosystem of plugins, or owns a piece of core UX.

The test for adopting a package:
1. **Is it single-purpose?** Utilities (encoders, parsers, formatters) are fine. Frameworks (editors, state machines, UI systems) are risky.
2. **Does it own the UX or just support it?** Supporting code can be swapped out. Code that owns the interaction model cannot.
3. **Is the custom code genuinely fragile or hard to maintain?** If it's stable and readable, keep it.

---

## Decisions

### WAV encoder (`web/src/lib/audio.ts`)

**Current:** 43 lines of bit-twiddling that writes a PCM WAV header manually.
**Candidate:** `wav-encoder` npm package.
**Decision: adopt `wav-encoder`.**

The current code is correct but this is exactly the kind of low-level format detail that is easy to get wrong (endianness, header offsets). `wav-encoder` is a single-purpose utility with no API surface beyond one function. If it ever disappears, the current code is right there to copy back. Zero lock-in risk.

The sound effect functions (`playMicSound`, `playPermissionSound`) use the Web Audio API directly and are fine as-is — clean, understandable, no reason to replace them.

---

### Diff parser (`web/src/lib/diff.ts`)

**Current:** 15 lines, splits unified diff on `--- a/` boundaries.
**Candidate:** `diff` or `diff-match-patch` npm packages.
**Decision: keep custom.**

The parser is 15 lines. It handles the only format this app generates (Claude-produced unified diffs). There's nothing fragile about it. Adding a dependency for 15 lines is not a trade worth making.

---

### Input area (`web/src/components/InputArea.tsx`)

**Current:** ~800 lines, custom textarea + overlay approach. Handles markdown syntax highlighting, `/command` palette, `@mention` palette, drag-and-drop attachments, dynamic height.
**Candidates:** `tiptap`, `slate`, `lexical`, `draft-js`.
**Decision: keep custom.**

Rich text editors are frameworks, not utilities. They have their own data models, extension systems, and release cadences. They break APIs between major versions. Adopting one would mean:
- Learning a new abstraction layer for every future change to input behaviour
- Fighting the framework whenever we need something it doesn't support natively (and we will)
- Losing direct control over the most interaction-critical part of the UI

The input area has some bugs, but they are bugs we can fix. The `highlightInputText` function is readable — it tokenises on backtick spans, then applies inline patterns pass-by-pass to avoid matching across already-inserted HTML. That's a clear, understandable approach.

**Verdict: own this code.** The swap cost would be high, the lock-in would be real, and the gain is uncertain.

**Known limitation:** The textarea + overlay approach has inherent cursor drift — the visible cursor lives in the `<textarea>` while highlights are rendered in the overlay `<div>`, and sub-pixel font rendering differences cause them to drift slightly when markdown spans are injected. This is not a logic bug and cannot be fully fixed without switching to `contenteditable`. The fix would be ~100-150 lines: replace the `<textarea>` + overlay with a single `<div contenteditable>` — no framework needed. Deferred until cursor drift becomes a real user complaint.

---

### WebSocket hook (`web/src/hooks/useWebSocket.ts`)

**Current:** ~365 lines. Custom reconnection state machine, exponential backoff, intentional-close tracking, 15+ custom event types, full state sync on reconnect, 25-second keepalive.
**Candidate:** `react-use-websocket`.
**Decision: keep custom.**

A generic WebSocket library handles reconnection and keepalive. Everything else — the event protocol, the state sync, the intentional-close distinction — is project-specific and would still need to be written on top. The result would be more code, not less, with a dependency in the middle.

---

### Voice activity detection (`web/src/hooks/useMic.ts`)

**Current:** RMS-threshold VAD. Tunable via settings, has silence tail to prevent word clipping.
**Candidate:** `silero-vad` (ML-based, WASM binary, ~1-2 MB).
**Decision: keep custom for now.**

The ML approach would produce noticeably better VAD quality — fewer false positives, handles whispering, more robust in noisy environments. But:
- 1-2 MB WASM binary adds real startup cost
- Requires an ONNX runtime
- Potential issues in sandboxed/offline environments
- Current VAD is working and user-tunable

Revisit if VAD quality becomes a recurring complaint. The improvement is genuine, the cost is real.

---

### Command palette (`/` and `@` in InputArea)

**Current:** Custom combobox inside InputArea.
**Candidate:** `cmdk`.
**Decision: low priority, revisit if refactoring InputArea.**

`cmdk` is small, well-maintained, and a reasonable fit. Not worth the migration unless we're already doing a larger InputArea change.

---

### PiP (`web/src/hooks/usePiP.ts`)

**Current:** Custom Document PiP with auto-mode (silent oscillator + Media Session trick for tab-switch activation).
**Candidates reviewed:** `react-document-picture-in-picture`, `react-document-pip`.
**Decision: keep custom.**

Both packages use React portals (rendering components into the PiP window); our approach uses an iframe that loads the full app. These are architecturally different. Neither package handles the auto-mode trick. Both have <100 weekly downloads. The custom code is doing something genuinely non-trivial that no package covers.

---

### What we already use (and are happy with)

| Area | Package | Notes |
|------|---------|-------|
| State | `zustand` + `persist` | Right choice, keep |
| Markdown | `marked` | Fine, no need to switch |
| Terminal markdown | `marked-terminal` | Good fit |
| Diff rendering | `diff2html` | Good choice |
| Styling | Vite + vanilla CSS | No framework lock-in |
| Testing | `vitest` + Playwright | Correct stack |
| LLM | `@anthropic-ai/sdk` | Core dependency, expected |

---

## Summary table

| Component | Package candidate | Decision |
|-----------|-------------------|----------|
| WAV encoder | `wav-encoder` | **Adopt** |
| Diff parser | `diff` | Skip — 15 lines |
| Input area | `tiptap` / `slate` | Skip — framework lock-in |
| WebSocket hook | `react-use-websocket` | Skip — too project-specific |
| VAD | `silero-vad` | Defer — WASM overhead |
| Command palette | `cmdk` | Low priority |
| PiP | various | Skip — too specialised |
