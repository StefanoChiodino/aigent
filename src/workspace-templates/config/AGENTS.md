# AGENTS.md — Operating Instructions

## Every Session

Before doing anything else:

1. Read `SOUL.md` — this is who you are
2. Read `USER.md` — this is who you're helping
3. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context
4. Read `MEMORY.md` for long-term context

These files are already loaded into your system prompt. Don't re-read them unless you need to check for updates.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** `memory/YYYY-MM-DD.md` — raw logs of what happened
- **Long-term:** `MEMORY.md` — curated memories, decisions, lessons learned

**Write things down.** If you want to remember something, update a file. "Mental notes" don't survive session restarts.

### When to Write (Do This Proactively)

**Update USER.md when you learn:**
- Their name, role, company, or any personal info they share
- Preferences (coding style, communication style, tools they like/hate)
- Projects they're working on
- Opinions they express strongly

**Update MEMORY.md when:**
- A decision is made about architecture, design, or approach
- You discover something non-obvious (a bug, a workaround, a gotcha)
- A task is completed — record what was done and why
- Something fails — record what went wrong so you don't repeat it

**Update TOOLS.md when:**
- You hit a tool limitation or gotcha
- You find a better way to use a tool
- A new tool is added or an existing one changes

**Update daily log (memory/YYYY-MM-DD.md) when:**
- Starting a new task — record what was asked
- Finishing a task — record what was done
- Something notable happens mid-session

**Don't wait until the end.** Write as you go. If the session crashes, anything you didn't write down is gone.

### What Goes Where

| File | Purpose | Update frequency |
|------|---------|-----------------|
| `SOUL.md` | Who you are, personality, values | Rarely — only when something fundamental changes |
| `USER.md` | Info about the human | When you learn something new about them |
| `MEMORY.md` | Curated long-term knowledge | After significant decisions or discoveries |
| `TOOLS.md` | Tool notes and gotchas | When you learn something about a tool |
| `memory/YYYY-MM-DD.md` | Daily session log | Throughout the session |

## Testing — E2E First

**Default: write an E2E test.** Every new feature or bug fix gets a Playwright spec. Unit tests are secondary and only for logic that is genuinely hard to drive through the browser (e.g. pure utility functions, store mutations with complex invariants).

### Test Infrastructure

**E2E (primary):** Playwright — `npm run test:e2e` from `/app`
- Specs live in `/app/tests/specs/` — numbered by feature area
- Config: `/app/playwright.config.ts` — Chromium only, 30s timeout, 1 worker, 0 retries
- Global setup/teardown: `/app/tests/global-setup.ts` / `global-teardown.ts`
- Helpers: `/app/tests/helpers/` — shared page setup, mocks, etc.
- Run with `SCREENSHOTS=1` env var to capture screenshots on all tests

**Unit (secondary):** Vitest — `npm run test:web` from `/app`
- Specs live in `/app/web/src/__tests__/`
- Config embedded in `vite.config.ts` — jsdom, globals: true
- Currently covers: connection store, InputArea submission, permission flow, WS race regression

### When Adding a Feature

1. **Write the Playwright spec first** (or alongside). Name it `NN-feature-name.spec.ts` where `NN` follows the next available number.
2. Use `useSharedPage()` for isolated browser context per test.
3. Install any required browser mocks (mic, screen, etc.) via `page.evaluate()` before the test runs.
4. Assert on DOM state, not implementation details.
5. Only write a Vitest unit test if the logic is pure and complex enough to warrant it.

### When Fixing a Bug

**Always add a regression test** — either a new `describe` block in the relevant spec, or a new spec file. The test should fail before your fix and pass after.

### Test Conventions

- **Timeouts**: Use named constants, not magic numbers.
  ```typescript
  const T = { RECORDING_START: 3_000, TRANSCRIPTION: 5_000 };
  ```
- **Frame counts**: Comment what the number means.
  ```typescript
  await fireLoudFrames(page, 48); // 48 × 4096 samples = 196k > MIC_WINDOW_SAMPLES
  ```
- **Shared mocks**: If a mock is used in two+ spec files, extract it to `tests/helpers/`.
- **Retries**: Keep `retries: 0` locally. For CI, set `retries: 2` via env:
  ```typescript
  retries: process.env['CI'] ? 2 : 0,
  ```
- **Workers**: Currently 1 (serial). Don't bump without verifying test isolation first.

### Known Coverage Gaps (write specs for these)

These features have **no E2E coverage** as of last audit:
- **TTS streaming** — auto-speak during LLM response, rate adjustment, stop button
- **Screen capture flow** — actual capture, preview, send (spec `20-input-area` only checks button visibility)
- **Attachment upload** — the real `#attach` button → file picker → preview flow (current spec injects via `evaluate()`)
- **Mic/STT error paths** — getUserMedia denied, STT 500/timeout, AudioContext unavailable
- **TTS error paths** — `/tts` endpoint failures, rate limiting
- **VAD timing** — verify vad-active class is removed after silence, not just added

### What NOT to Over-Test

- Don't unit test Zustand stores in isolation unless the mutation logic is genuinely complex — the E2E tests exercise stores end-to-end.
- Don't snapshot test components — too brittle, don't catch real bugs.
- Don't test CSS/styling correctness in Vitest — that's what E2E visual tests are for.

## Code Complexity Notes

These areas have complexity worth knowing about before touching them:

### useMic.ts — Microphone streaming (~287 lines)
The 12-second window-capping (`MIC_WINDOW_SAMPLES = 16000 * 12`) is intentional: Whisper allows 30s but 12s gives better accuracy + lower latency on live chunks. The complexity (seq counters, concurrent AbortControllers, VAD hysteresis, silence tail buffer) is all load-bearing — don't remove any of it without understanding the E2E accumulation tests in `26-mic-accumulation.spec.ts`.

If the backend STT model changes to one without a context window limit, the windowing logic can be removed — but update the E2E tests first.

### useTTS.ts — TTS streaming (~177 lines)
Sentence-boundary detection (`/[.!?]['\"»]?\s+|\n\n/g`) and the Promise-queue drain are both necessary — without them audio overlaps or cuts off mid-word. The demo mode (`SpeechSynthesis` fallback) can be removed if there's no demo environment requirement.

### InputArea.tsx — Markdown highlight (lines 27–104)
Uses a two-phase approach: split on existing `<span>` tags between each regex pass so later patterns can't match across already-inserted HTML. This was a deliberate bug fix — don't revert to chained `.replace()` calls.

## Safety

- Don't exfiltrate private data
- Don't run destructive commands without asking
- When in doubt, ask

## Self-Modification

You can modify your own source code at `/app/src/`. After changes:
1. Run `npx tsc --noEmit` to verify compilation
2. The changes will persist on the host filesystem

Your workspace files and source code are both writable. Use that power responsibly.
