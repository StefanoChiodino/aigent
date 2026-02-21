# Design: Headless Browser Tool

## 1. Motivation

Currently, Aigent relies on `fetch` with optional HTML-to-text stripping. This is insufficient for the modern web because:
*   Single Page Applications (SPAs) return empty HTML shells.
*   Interactivity (clicking, expanding menus, logging in) is impossible.
*   The DOM structure is lost when blindly stripping tags, making it hard for the LLM to understand what constitutes a button vs. a paragraph.

A first-class `browser` tool will allow the agent to navigate, interact with, and extract data from complex web applications.

## 2. Architectural Challenges

Unlike `fetch`, which is a stateless one-off execution, a browser session must be **stateful**. 
*   If the agent navigates to a page in Tool Call 1, the browser must remain open so the agent can click a button in Tool Call 2.
*   This requires maintaining a persistent Playwright/Puppeteer browser context in memory on the Node.js backend for the duration of the agent's session.

## 3. Implementation Options

### Option A: Built-in Tool via Playwright
*   **Pros:** Tight integration, can share the same SSRF protections as `fetch`, can directly capture Xvfb screenshots.
*   **Cons:** Playwright requires heavy system dependencies (Chromium, WebKit, system libraries). Adding this to the Docker image will significantly increase the image size (often by 1GB+).

### Option B: The MCP Approach (Recommended)
*   **Pros:** Keeps the core Aigent Docker container lightweight. Offloads the heavy lifting to an external process via `mcp.json`. Anthropic already maintains an official `@modelcontextprotocol/server-puppeteer`.
*   **Cons:** Slightly higher latency due to RPC overhead; SSRF protections must be enforced within the MCP server itself.

*Decision:* Even if implemented as a built-in tool, it should be heavily isolated. We will design the interface assuming a built-in stateful tool, but strongly consider migrating it to an MCP standard.

## 4. Proposed Tool Schema (`browser`)

The tool should accept an `action` and specific parameters based on the action.

```typescript
{
  name: "browser",
  description: "Interact with a headless web browser. The browser retains state across calls. Use this for SPAs, logging in, or when fetch fails.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "type", "scroll", "extract_html", "extract_a11y", "screenshot", "close"]
      },
      url: { type: "string", description: "For 'navigate' action" },
      selector: { type: "string", description: "CSS selector for 'click' or 'type'" },
      text: { type: "string", description: "Text for 'type' action" },
      direction: { type: "string", enum: ["up", "down"], description: "For 'scroll' action" }
    },
    required: ["action"]
  }
}
```

## 5. The Accessibility (a11y) Tree

Extracting raw HTML is extremely token-heavy and full of noise (SVGs, inline styles, scripts).
Instead of returning `document.body.innerHTML`, the `extract_a11y` action should return the **Accessibility Object Model (AOM)** or a simplified DOM.

A simplified representation looks like:
```text
[Button] "Log In" (id: login-btn)
[Link] "Forgot Password?" (href: /forgot)
[Input:text] "Email Address" (name: email)
```
This reduces token usage by 90% while giving the LLM exact targets for the `click` and `type` actions.

## 6. Security Considerations

1.  **SSRF in the Browser:** The `navigate` action MUST pass through `validateFetchUrl(url)` to prevent the headless browser from accessing `http://localhost:3141` (the gatekeeper UI) or cloud metadata.
2.  **Resource Exhaustion:** A rogue script on a visited page could crash the browser. A strict memory and timeout limit must be set on the browser context.
3.  **File Downloads/Uploads:** By default, block the browser from downloading files to the host or uploading files from the sandbox unless explicitly handled and sanitized.
4.  **Persistence:** Ensure the browser context is forcefully closed when the agent session resets or idles for > 15 minutes to free up RAM.