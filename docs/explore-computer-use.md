# Exploration: Desktop Computer Use Architecture

This document explores the patterns, trade-offs, and architectural options for enabling Aigent to control a host desktop environment (GUI automation). It focuses on the "observe → decide → act" loop.

## 1. The Core Challenge: The Observation Loop

To interact with a desktop application, an agent must first understand what is on the screen and where elements are located. There are two primary paradigms for this observation step.

### Paradigm A: Pure Visual (Pixels to Coordinates)
This is the approach taken by Anthropic's native `computer-use` tool.
*   **Mechanism:** The agent takes a screenshot, passes it to a Vision LLM, and receives X/Y coordinates for the element it wants to click.
*   **Strengths:** Universal compatibility. If a human can see it, the agent can click it. Works across all OSs, web browsers, terminal emulators, and legacy Java/Flash apps.
*   **Weaknesses:** 
    *   **Cost & Latency:** Passing a 1080p image to an LLM every 2 seconds is incredibly expensive and slow.
    *   **Precision:** Vision models frequently hallucinate exact pixel coordinates, leading to missed clicks.
    *   **State:** The image contains no semantic meaning (e.g., is this text box focused? Is this button disabled?).

### Paradigm B: Semantic / Accessibility Trees (AOM/UIAutomation)
This approach reads the structured data the OS maintains for screen readers.
*   **Mechanism:** The agent queries the OS Accessibility API to get a JSON-like tree of all windows, buttons, text fields, and their bounds/coordinates.
*   **Strengths:**
    *   **Cost & Speed:** Passing a text tree to an LLM is orders of magnitude cheaper and faster than image processing.
    *   **Precision:** The API provides exact bounding boxes (X, Y, Width, Height) and semantic roles (Button, Checkbox).
    *   **State:** The tree explicitly declares if an element is `focused`, `disabled`, or `checked`.
*   **Weaknesses:**
    *   **Platform Fragmentation:** Requires writing entirely different integration code for Windows (UI Automation), macOS (NSAccessibility), and Linux (AT-SPI).
    *   **App Support:** Apps that don't use standard UI frameworks (e.g., custom games, some Electron apps) often have broken or empty accessibility trees.

### Hybrid Pattern (The Ideal State)
Provide the agent with *both* the accessibility tree and a compressed screenshot. The semantic tree provides exact coordinates and state, while the screenshot provides visual context (e.g., recognizing an icon that lacks an aria-label).

## 2. The Action Loop (Keystrokes & Clicks)

Once the agent decides what to do, it must execute the action. Because Aigent runs in a Docker sandbox, but wants to control the *Host* OS, the execution boundary is critical.

### Option 1: Sandbox Xvfb Automation
*   **Concept:** The agent automates a virtual desktop *inside* the Docker container using `xdotool` or Playwright.
*   **Pros:** Perfectly sandboxed. Zero risk to the user's actual host machine.
*   **Cons:** Limits the agent to only interacting with web apps (via a sandboxed browser) or Linux CLI tools. It cannot interact with the user's host IDE, host file explorer, or host applications (e.g., Xcode, Excel).

### Option 2: Host Daemon Automation (via `aigent-host`)
*   **Concept:** The Sandbox sends RPC commands (`{action: "click", x: 100, y: 200}`) to the Gatekeeper process on the Host. The Host executes the physical mouse/keyboard events.
*   **Libraries:** 
    *   `nut.js` (Cross-platform Node.js library for desktop automation, handles OpenCV image matching and I/O).
    *   `robotjs` (Older, but very fast cross-platform C++ bindings).
*   **Pros:** Full control of the user's actual working environment. The agent can switch windows, open the user's IDE, and type code.
*   **Cons:** Extremely high risk. A hallucination could cause the agent to click "Delete Repo" or send an embarrassing Slack message on the host machine.

## 3. Sandboxing & Safety Patterns for Host Automation

If proceeding with Option 2 (Host Daemon Automation), the following safety patterns are heavily recommended across the industry:

1.  **The Big Red Button:** The Host Gatekeeper must listen for a global OS hotkey (e.g., `Cmd+Escape`) that instantly kills the Sandbox process and halts all mouse/keyboard events.
2.  **Visual Indicators:** The screen should display a persistent, un-closable overlay (e.g., a bright red border or floating widget) whenever the agent has control of the mouse/keyboard.
3.  **Action Batching vs. Step-by-Step:**
    *   *Step-by-Step:* The agent proposes one action (move mouse), gets a screenshot, then clicks. (Too slow, frustrating for the user).
    *   *Macro/Batching:* The agent proposes a sequence `[click(10,20), type("hello"), press(Enter)]`. This is faster but much riskier if the UI state changes mid-execution.
4.  **The "Ghost" Cursor:** Instead of taking over the user's physical mouse, some advanced implementations draw a secondary "software" cursor on the screen and use API-level synthetic events directed at specific window handles, allowing the user to keep working. (Very difficult to implement cross-platform).

## 4. Exploration Checklist for Implementation

If deciding to build this out, the technical exploration phase should answer:

- [ ] Can `nut.js` be cleanly integrated into the `gatekeeper.tsx` process without breaking the React SSR loop?
- [ ] How reliable are cross-platform Node packages for reading the Accessibility Tree (e.g., `@access-tool/core`) versus calling native binaries (like AppleScript on Mac or `xdotool` on Linux)?
- [ ] How to handle multi-monitor coordinate math (sandbox `[0,0]` vs host monitor `[1920, 1080]`)?