# Design: Observability and Tracing

## 1. Motivation

Aigent is a multi-process system. A single user interaction might touch:
1. The Browser UI
2. The Gatekeeper (Host Node.js process)
3. The LLM API (Anthropic/OpenAI)
4. The Sandbox Agent loop (Docker Node.js process)
5. A Background Sub-agent (Another Sandbox process)
6. An MCP Server (External plugin process)

Currently, logs are scattered. If a background task fails, or an MCP server crashes, finding the relevant logs and tying them back to the user's original request is difficult.

We need a lightweight, structured way to trace a request end-to-end without introducing heavy dependencies like OpenTelemetry.

## 2. The Correlation ID

The core mechanism will be a **Correlation ID** (`reqId`). This is a short, unique string (e.g., a 6-character hex like `a1b2c3`) generated when the user submits a message.

This ID must be passed down the stack and attached to every log line related to that request.

### Flow

1. **Browser UI:**
   * User types "Search my files for passwords".
   * UI generates `reqId: "f9d8e7"`.
   * UI sends POST `/chat` with payload: `{ message: "...", reqId: "f9d8e7" }`.

2. **Gatekeeper:**
   * Receives `reqId`.
   * Passes `reqId` in the NDJSON IPC payload sent to the Sandbox.
   * All Gatekeeper logs regarding this request (LLM proxying, permission checks) prepend `[f9d8e7]`.

3. **Sandbox Agent (`agent.ts`):**
   * Receives `reqId` from the Gatekeeper.
   * Uses Node.js `AsyncLocalStorage` to store the `reqId` for the current execution context.
   * The custom `logger.ts` automatically pulls `reqId` from `AsyncLocalStorage` and prepends it to all logs.

4. **Background Tasks (`dispatch_task`):**
   * When spawning a background agent, the parent agent passes its current `reqId` to the child process via an environment variable (e.g., `AIGENT_REQ_ID=f9d8e7`).
   * The sub-agent's logger picks this up.

5. **MCP Servers:**
   * MCP servers are separate processes. The Sandbox acts as the MCP Client.
   * When sending JSON-RPC requests to an MCP server, the Sandbox can pass the `reqId` in the `_meta` parameter (a standard extension point in JSON-RPC).
   * Note: MCP servers must be built to respect and log this `_meta.reqId` for full tracing.

## 3. Structured Audit Logging

Alongside tracing, we need an **Audit Log**. Standard debug logs are noisy. We need a guaranteed stream of security-relevant events that are never filtered out by log levels.

### Requirements
*   **Format:** Key-Value or JSON for easy parsing (e.g., `[AUDIT] action=mount path=/tmp result=denied reqId=f9d8e7`).
*   **Storage:** Written to a dedicated `audit.log` file on the host, separate from standard `stderr`.
*   **Events to Audit:**
    *   `request_mount`: Path, requested mode, result (approved/denied).
    *   `exec` / `fetch`: Command/URL, permission tier matched, result.
    *   `request_config_write`: File, diff size, result.
    *   Startup / Shutdown events.

## 4. Implementation Steps

1.  **Introduce `AsyncLocalStorage` in `src/logger.ts`:** Create a store to hold the `reqId`. Update the `log` function to check the store and prefix the message.
2.  **Generate `reqId` in UI:** Update `web/index.html` to generate and send the ID.
3.  **Thread through Gatekeeper:** Update `gatekeeper.tsx` to accept the ID, log it, and pass it via the IPC socket to `agent.ts`.
4.  **Initialize Context in Sandbox:** Update `agent.ts` to wrap the conversation loop handler in `asyncLocalStorage.run(reqId, ...)`.
5.  **Sub-agents:** Update `spawn_agent` and `dispatch_task` in `tools.ts` to pass the ID via `env`.
6.  **Audit Logger:** Create a secondary logger instance specifically for `[AUDIT]` events that writes to a rolling file on the host.