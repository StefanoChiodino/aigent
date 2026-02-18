# TUI Architecture — Design Decisions

> Why Ink, why fixed-height, and what we learned from Claude Code.

---

## Framework Choice: Ink (React for CLI)

We use **Ink v6** (React for terminals) with **Yoga** (flexbox layout).

### Why Ink

The deciding factor comes from Claude Code's architecture team (Boris Cherny):

> "We wanted a tech stack which we didn't need to teach: one where Claude
> Code could build itself."

This is the **"on distribution" argument**: TypeScript + React are deeply
represented in LLM training data. Since aigent is a self-authoring agent
(~90% of Claude Code's code is written by Claude Code itself), the AI must
be fluent in its own UI framework. Exotic stacks (blessed, terminal-kit,
raw ncurses) are "off distribution" — the model would be worse at
contributing to its own codebase.

Additional reasons:
- **React component model** — familiar hooks, state, JSX, declarative rendering
- **Yoga flexbox** — CSS-like layout without learning a bespoke TUI API
- **Ecosystem** — most popular React-for-terminal library, actively maintained
- **TypeScript native** — first-class types

### What Ink is bad at

Ink's rendering model has a fundamental tension with our use case:

1. **No true fixed regions.** Ink lacks a way to say "this area is pinned,
   that area scrolls." Everything below `<Static>` is a single "live"
   region that re-renders entirely on any state change.

2. **Re-render cascades.** A spinner ticking at 80ms, a timer updating at
   1s, or a task counter changing — each triggers a full repaint of all
   non-Static content. Variable-height live content + rapid repaints =
   artifacts bleeding into scrollback.

3. **Width inference.** Ink doesn't reliably propagate width from parents.
   Every `<Box>` that needs terminal-width-aware layout must get explicit
   `width={cols}`. Flex properties don't work without this.

4. **`<Static>` is one-way.** Items pushed to `<Static>` live in scrollback
   and render once. Good for completed messages. But you can't update them,
   and any key change causes a re-render.

### What Claude Code did about it

Claude Code hit the same problems and invested heavily:

- **Rewrote the renderer from scratch** while keeping React as the component
  model. Their pipeline: React scene graph → Yoga layout → rasterize to 2D
  cell buffer → diff against previous frame → emit minimal ANSI sequences.
  ~5ms frame budget. Effectively "a small game engine."

- **Contributed upstream patches** for synchronized output (DEC mode 2026)
  to VSCode's terminal and tmux, which eliminates flickering.

- **Chose NOT to use alternate screen buffer** to preserve native terminal
  search (Cmd+F), text selection, and scrollback. This made rendering much
  harder but preserved the "native terminal experience."

- **Result**: ~85% flicker reduction, but massive engineering investment.

### Our approach: simpler

We don't have the bandwidth for a custom renderer. Instead, we constrain
the problem: **make the live region fixed-height so Ink's re-render
behaviour is harmless.**

---

## Layout: Fixed-Height Input Box

The entire UI has two zones:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Chat messages (Ink <Static>)                          │
│   ─ completed messages render once into scrollback      │
│   ─ never re-rendered, never affected by live region    │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   Input Box (live region — the ONLY non-Static element) │
│   ─ fixed height (4 lines)                              │
│   ─ re-renders are confined to this box                 │
│   ─ no height changes = no scrollback pollution         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### The Input Box (4 fixed lines)

```
┌── r:on H │ 2 tasks │ $0.45 │ ████░░░░ 12k/200k (6%) ──┐
│ ⟳ reading src/agent.ts:1-50                              │
│ > your message here                                      │
└──────────────────────────────────────────────────────────┘
```

| Line | Content | Height |
|------|---------|--------|
| 1 | Top border + status chips | Always 1 line |
| 2 | Activity row (streaming preview / tool / reasoning / notification) | Always 1 line |
| 3 | Input prompt (`> `) + text input | 1 line (grows only with user typing, which is slow) |
| 4 | Bottom border | Always 1 line |

### Status chips (Line 1, top border)

All status information is encoded as short chips in the top border:

| Chip | Example | When shown |
|------|---------|------------|
| Reasoning level | `r:on H` | Always |
| Task counter | `2 tasks` | When background tasks are running |
| Cost | `$0.45` | When > $0 |
| Context bar | `████░░░░ 12k/200k (6%)` | When > 0 context tokens |

Chips are separated by `│` and rendered in gray against the border.

### Activity row (Line 2)

Shows ONE thing at a time, priority order:

1. **Error** (red) — API errors, connection issues
2. **Streaming preview** — last line of the LLM's streaming output
3. **Tool activity** — `⟳ reading src/agent.ts:1-50`
4. **Reasoning indicator** — `⟳ reasoning…`
5. **Notification** — transient system messages (auto-clear after 5s)
6. **Background tasks** — `N background tasks running` (when idle)
7. **Empty** — single space (maintains height)

### Why this works

The key insight: **if the live region never changes height, Ink's
"re-render everything below Static" behaviour is harmless.** It repaints
the same 4-line box every time. The chat messages above are in `<Static>`
and are never touched.

The only way the box grows is the user typing a multi-line message (e.g.,
pasting). This is slow, user-initiated, and infrequent — not a rapid
automated state change.

---

## What we gave up (and why it's OK)

| Feature | Status | Why |
|---------|--------|-----|
| Spinners / animations | Removed | 80ms re-render ticks caused artifacts. Static text (`⟳`) is stable. |
| Expanded task list | Removed | Variable height = re-render artifacts. Counter in status line instead. |
| Elapsed time display | Removed | 1s setInterval ticks caused constant repaints. |
| Per-task detail lines | Removed | Each task = +1 line height = height thrashing. Use `/tasks` command. |
| Multiple notification lines | Removed | Keep last notification, auto-clear after 5s. |

These are acceptable trade-offs. Users who want task details can run
`/tasks`. The status line gives at-a-glance awareness (how many tasks,
what's happening now) without the rendering cost.

---

## Alternatives Considered

### Raw ANSI with DECSTBM scroll regions

The technically "correct" solution. DECSTBM (`ESC[top;bottom r`) creates
hardware scroll regions — status bar and input physically cannot scroll.
This is what tmux, less, and vim use.

**Pros**: Perfect zone isolation, zero framework overhead, best streaming perf.
**Cons**: High implementation effort (resize handling, word wrapping, input
readline, ANSI color management). Would need to rebuild TextInput from scratch.

**Verdict**: The right tool if Ink becomes untenable. Currently overkill
given the fixed-height constraint solves the problem.

### blessed / @unblessed/core

ncurses-like widget library with native fixed regions.

**Pros**: Built-in scroll regions, damage buffer rendering.
**Cons**: blessed is abandoned. @unblessed/core is alpha. Imperative API
is "off distribution" for the AI. No flexbox.

**Verdict**: Good fallback, but "off distribution" concern is real.

### terminal-kit

Comprehensive terminal control with ScreenBuffer and scroll regions.

**Pros**: Delta rendering, scroll regions, lighter than blessed.
**Cons**: Single maintainer, imperative API, not React-based.

**Verdict**: Viable but same "off distribution" issue.

### OpenTUI

New TypeScript TUI with Zig rendering core and React reconciler.

**Pros**: Flexbox + React + fast native rendering. Best of all worlds.
**Cons**: Pre-release (v0.1.x), API unstable, requires Zig toolchain.

**Verdict**: Watch this space. Could be the future answer.

### Ink + alternate screen buffer

Via `fullscreen-ink` package. Gives proper viewport control.

**Pros**: Easier than DECSTBM from scratch.
**Cons**: Loses native Cmd+F, text selection, scrollback. Claude Code
explicitly rejected this for the "native terminal experience."

**Verdict**: Acceptable if we decide native UX is less important than
rendering stability. Currently not needed with fixed-height approach.

---

## Implementation Guidelines

### Rules for the live region (InputBar)

1. **Never change height dynamically.** If content doesn't fit on one line,
   truncate it. Use `…` for overflow.

2. **No animated components.** No `ink-spinner`, no `setInterval` for
   elapsed time, no blinking cursors. Use static unicode symbols (`⟳`).

3. **One state per line.** Line 2 shows exactly one thing. Priority order
   determines what. No stacking.

4. **Always set `width={cols}` on Box.** Ink doesn't propagate width
   reliably. Every row needs explicit width.

5. **Suggestions overlay is the exception.** Tab-completion suggestions
   appear above the box (variable height). This is OK because it only
   triggers on user input (Tab key), not on automated state changes.

### Rules for Static (chat messages)

1. **Messages go to Static once complete.** Streaming text stays in the
   live region (InputBar line 2) until the full message is ready.

2. **Each Static item gets a stable key.** Use message index or timestamp.
   Changing keys causes re-renders.

3. **Wrap Static items in `<Box width={cols}>`** for flex properties to
   work (justifyContent, etc.).
