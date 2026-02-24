# OS Automation Strategy

> Decision record for how aigent should approach operating system presence and automation.
> Written 2026-02-24.

## The Problem

The agent is currently confined to the browser UI. The goal is to give it real OS presence — the ability to observe and act on the full desktop environment, not just respond to chat.

## Options Considered

### 1. OS Accessibility APIs (AT-SPI / NSAccessibility / UIA)

**What it is:** Every major OS exposes a structured accessibility tree of running applications — window titles, button labels, text fields, focus state. Screen readers use this. An agent can use it too.

**The appeal:** Semantically grounded (works on structure, not pixels), low-latency, no vision model cost per action.

**The reality:**
- AT-SPI is Linux/X11 only
- NSAccessibility is macOS only
- UI Automation is Windows only
- They have completely different APIs, different quirks, different permission models
- Cross-platform abstraction is a real multi-month engineering project

**WSL2 specific problem:** The aigent sandbox runs in a Linux Docker container inside WSL2. It cannot see Windows GUI applications through AT-SPI at all. To control native Windows apps, you'd need a separate lightweight Windows-side agent (Python + `pywinauto` or AutoHotkey) communicating back over a socket. That's a second deployment target with its own maintenance burden.

**Verdict: Too fragile, too platform-specific, too much infrastructure for the return.**

---

### 2. Screenshot + Vision (Anthropic Computer Use API)

**What it is:** Capture a screenshot, send it to Claude with a task, get back a click/type action, execute it, repeat.

**The appeal:** Truly cross-platform. Works on anything with a display. No accessibility API dependency.

**The costs:**
- Every action requires a screenshot → vision model round-trip
- At ~1M pixels per screenshot, token costs add up fast if the agent is navigating through many steps
- Latency: screenshot → API → action is measurably slower than a direct accessibility call
- Fragile for precise work (pixel coordinates drift, UI rendering differences)

**The real use case:** This is best as a **fallback** — when nothing else works, when you need to interact with a legacy app, a game, or anything with no a11y tree. Not the primary path.

**Verdict: Viable but expensive. Good as escape hatch, not as primary strategy.**

---

### 3. Browser Automation (Playwright) ✅ CHOSEN PRIMARY PATH

**What it is:** A headless Chromium instance that the agent controls programmatically. Full DOM access, JS execution, network interception, screenshot, accessibility tree — all available.

**Why this wins:**

1. **The web is where most work happens.** Gmail, GitHub, Notion, Slack web, every SaaS tool, every dashboard — all accessible via browser. This covers the vast majority of real automation tasks.

2. **The a11y tree solves the token problem.** Playwright exposes `page.accessibility.snapshot()` — a structured tree of interactive elements, identical in concept to AT-SPI but for the DOM. The agent gets `[Button] "Submit"`, `[Input] "Search"` etc. — not raw HTML. Token cost is ~10x lower than screenshot-based navigation.

3. **Selector-based actions are reliable.** Click by CSS selector, ARIA label, or text content. No coordinate drift, no vision model needed for standard interactions.

4. **Screenshots available when needed.** For visual tasks (verify a chart loaded, check an image rendered correctly), a screenshot can be taken on demand — not on every step.

5. **Platform-independent.** Runs identically in Linux Docker, macOS, Windows. No OS-specific code paths.

6. **Already designed.** See `docs/design-headless-browser.md` for the full tool schema and architecture.

---

## Decision

**Primary path: Chrome browser extension operating in the user's live session.**

Not headless Playwright — the key insight is that a parallel robot browser starts fresh with no logins, no history, no context. The extension rides along in the user's real browser where everything is already authenticated.

See `docs/design-browser-extension.md` for the full architecture and implementation plan.

Key points:
- **Live session:** operates on the user's real tabs, already logged into everything
- **a11y tree first:** `extract_a11y` returns structured element tree, ~800–2000 tokens vs ~20k for raw HTML
- **Batched action scripts:** agent plans in one LLM call, extension executes many steps locally — no per-click LLM round-trips
- **Gatekeeper bridge:** extension ↔ gatekeeper WebSocket (port 3141 `/ext`) ↔ agent Unix socket; extension never touches the sandbox directly
- **Read-only default:** write actions require explicit user grant via gatekeeper permission UI

**Headless Playwright: deferred.**

Still valid for unattended/CI runs where no live session exists. But not the primary path. The existing `docs/design-headless-browser.md` design stands for that use case.

**Secondary path: screenshot-based computer use (Anthropic API), deferred.**

For non-browser desktop apps (native apps, games, legacy software). Expensive — treat as escape hatch, not default.

**Native OS accessibility APIs: not pursued.**

Too platform-fragmented, broken in WSL2 without a second Windows-side agent. Revisit only if a compelling native-app use case arises that browser can't cover.

---

## What "OS Presence" Actually Means in Practice

With browser automation, the agent can:

- Log into any web service and navigate it autonomously
- Fill forms, click through multi-step workflows
- Extract structured data from SPAs that `fetch` can't see
- Monitor pages (take screenshot, compare, notify)
- Automate repetitive web tasks (file uploads, report generation, data entry)
- Use any web-based tool: GitHub, Linear, Notion, Google Workspace, etc.

This is genuinely powerful and covers most real-world use cases. True desktop app control (VS Code, Slack native, Finder/Explorer) is a separate problem to solve later with computer-use if the need arises.
