# aigent — TODO

---

## 🔒 Security & Safety (Current Priority)

- [ ] **Safety unit tests**
  - **Why:** `src/safety.ts` handles path validation, command safety, and SSRF protection. It is the security boundary of the sandbox and must be tested to ensure no regressions.
  - **What:** Use Node's native `node:test` runner.
  - **Tasks:**
    - Add `make test` target in `Makefile` (`tsx --test src/**/*.test.ts`).
    - Create `src/safety.test.ts`.
    - Test `validateWritePath`: ensure `/workspace` and `/tmp` pass, `/etc/passwd` and `../` fail.
    - Test `validateFetchUrl`: ensure public HTTPS passes; `localhost`, `127.0.0.1`, `169.254.x.x`, and `file://` fail.
    - Test `checkExecPermission`: ensure globs match correctly and `deny` overrides `allow`.
    - Test `validateReadonlyCommand`: ensure `rm`, `mkfs`, and output redirects (`>`) are blocked.
    - Test `sanitizedEnv`: ensure keys like `OPENAI_API_KEY` are stripped while `PATH` remains.

- [ ] **`fetch` permission tiers**
  - **Why:** Prevent data exfiltration. The agent shouldn't be able to POST sensitive host data to arbitrary domains without permission.
  - **What:** Implement a domain-based allow/prompt/deny model analogous to `ExecPermissions`.
  - **Tasks:**
    - Define `FetchPermissions` interface (e.g., `alwaysAllow: string[]`, `prompt: string[]`, `deny: string[]`).
    - Update `validateFetchUrl` in `src/safety.ts` to parse the hostname and match against globs.
    - Default unlisted domains to `prompt`.
    - Update `fetch` and `fetch_readonly` in `src/tools.ts` to request gatekeeper approval for `prompt` domains.

- [ ] **Harden SSRF protection against DNS rebinding**
  - **Why:** The current regex check on the string hostname is vulnerable to Time-Of-Check to Time-Of-Use (TOCTOU) attacks. An attacker can use a domain that resolves to a public IP during validation, but changes to `127.0.0.1` a millisecond later when `curl` runs.
  - **What:** Pin the IP address during validation and force `curl` to use it.
  - **Tasks:**
    - Use `dns.promises.lookup` in `validateFetchUrl` to resolve the hostname.
    - Run the private IP regex checks against the *resolved IP address*, not the hostname.
    - Update `src/tools.ts` to pass the `--resolve` flag to `curl` (e.g., `curl --resolve malicious.com:80:127.0.0.1 http://malicious.com`).

- [ ] **`fetch` response size cap**
  - Hard limit (e.g. 10 MB) to prevent large-payload exfiltration or OOM from a malicious URL.

- [ ] **`host.open` default to prompt**
  - Currently unrestricted; add domain/scheme policy (e.g. block `file://`, `javascript:`, non-HTTPS).

- [ ] **MCP server permission model**
  - Optional `permissions` block per server in `mcp.json` (allow/prompt/deny); default: `prompt` for all calls from any MCP server.

- [ ] **Self-mod policy**
  - Explicit list of files/paths the agent may edit autonomously vs. paths that require human approval (e.g. UI code OK; `safety.ts`, `gatekeeper.tsx`, `llm-proxy.ts` require diff review).

- [ ] **Read-only self-mount** *(in progress)*
  - Agent source mounted read-only by default; self-modification requires explicit opt-in writable mount.

- [ ] **Consistent mount path mirroring** *(in progress)*
  - Mounted host paths appear at identical absolute paths inside the container to avoid agent confusion.

---

## 🐛 Known Bugs / Open Issues

- [ ] **Duplicate mount suppression**
  - **Why:** The agent sometimes forgets it already has a mount and re-requests it, triggering a redundant permission modal.
  - **What:** The Gatekeeper should silently auto-approve redundant requests and return context.
  - **Tasks:**
    - Update `requestMount` logic in `server.ts`/`tools.ts`.
    - Check if the requested absolute host `path` and `mode` (where `rw` satisfies `ro`) are already in the active mounts list.
    - If true, return `res.ok = true` without triggering the web UI. Inject a context note: `"Mount already active: ${path} (${mountMode})"`.

- [ ] Not all models support reasoning; UI currently allows enabling it on models that don't (e.g. Haiku) — should disable the toggle or warn for incompatible models.
- [ ] Messages disappear on hard browser reload — see UI section below.

---

## 🔭 Observability

See `docs/design-observability.md` for architectural context.

- [ ] **Request correlation ID (`reqId`)**
  - Thread a random 6-char hex ID through UI → Gatekeeper → Sandbox → Sub-agents → MCP.
  - **Tasks:**
    - Generate `reqId` in `web/index.html` on submit.
    - Update `gatekeeper.tsx` to log and forward the ID.
    - Use `AsyncLocalStorage` in `src/logger.ts` to automatically prefix sandbox logs.
    - Pass `AIGENT_REQ_ID` to background tasks spawned via `dispatch_task` and `spawn_agent`.

- [ ] **Audit log stream**
  - **Why:** Debug logs are noisy; security needs a guaranteed, structured event stream.
  - **Tasks:** Write `[AUDIT]` entries to a dedicated rotating file on the host for mount approvals, exec/fetch permissions, config writes, and startup events.

- [ ] **Log rotation / max size**
  - Pipe `stderr` to `logrotate` or `pino-roll`, or build rolling file sinks into the logger.

- [ ] **Tool call audit trail in session logs**
  - Persist tool call events to the daily log so they survive context compaction and can be reviewed.

---

## 🪙 Token / Cost Optimisation

- [ ] **MCP tool name shortening** — `mcp_{serverName}_{toolName}` can be long with many servers; consider a shorter/hashed prefix convention to reduce per-request token overhead.
- [ ] **Tool description audit** — review all descriptions in `tools.ts`; trim any longer than ~100 tokens where the first sentence already gives the model sufficient context.
- [ ] **Prompt cache warm-up on startup** — send a minimal no-op message on init to pre-warm the Anthropic prompt cache before the first real user message.

---

## 🖥️ UI / UX

- [ ] **Persist conversation in browser storage**
  - **Why:** Prevent data loss of the visual chat history and sidebar state on accidental refresh.
  - **What:** Use `localStorage` with incremental append for messages.
  - **Tasks:**
    - Update `web/index.html` to store the array of messages in `localStorage.getItem('aigent_chat_history')`.
    - Retrieve and render the history on page load. Persist `aigent_model`, `aigent_reasoning`, and `aigent_effort`.
    - If the user clears the chat via `/reset`, clear the storage.

- [ ] **Reasoning / tool usage display** — show thinking blocks and tool calls more transparently in the UI without cluttering the main chat flow.
- [ ] **Browser extension** — read/write page DOM, manage tabs, fill forms, navigate pages; enables agentic browser automation without the overhead of a visual model.
- [ ] **Browser a11y tree** — expose structured page content (labels, roles, interactive elements) via the Accessibility Object Model or Chrome DevTools Protocol; cheaper and more reliable than screenshots for understanding page structure.

---

## 🤖 Computer Use / OS Automation

- [ ] **Headless browser tool**
  - A first-class `browser` tool wrapping Playwright or an MCP Server. Enables interacting with SPAs, auth flows, and complex DOMs.
  - See `docs/design-headless-browser.md` for architectural options.
- [ ] **Keyboard and mouse control** — send keystrokes and mouse events to the host or sandbox display; `xdotool` / `ydotool` on Linux, `nut.js` cross-platform; prerequisite for full GUI automation.
- [ ] **OS accessibility API** — enumerate windows and UI elements with their labels/roles via platform accessibility APIs (AT-SPI on Linux, NSAccessibility on macOS, UI Automation on Windows); lets the agent interact with desktop GUIs without relying on screenshots.
- [ ] **Application scripting** — where the OS supports it: AppleScript / JXA on macOS, COM automation on Windows; enables deep integration with desktop apps (e.g. controlling editors, terminals, mail).
- [ ] **Computer-use loop** — combine screenshot + accessibility + keyboard/mouse into a coherent "observe → decide → act" loop the agent can use for any GUI task.

---

## 🔌 Extensibility & Docs

- [ ] **README: "Extending with MCP"** — document `mcp.json` format with a working example (e.g. `@modelcontextprotocol/server-github`) so contributors know how to add tools without touching core code.
- [ ] **README: MCP permissions** — document the permission model once implemented.
- [ ] **CONTRIBUTING.md** — explain the "run the agent and ask it to implement something" workflow; code style, PR expectations, how to add a built-in tool vs. an MCP tool.

---

## 🧪 Testing

- [ ] **Integration smoke test** — headless `repl.ts`-based test: start agent, send a fixed message, assert a tool call is made; catches startup regressions.
- [ ] **Compaction round-trip test** — verify a compacted conversation can be continued without context errors or tool schema mismatches.

---

## 📦 Future / Low Priority

- [ ] **Packaging / installer** — single-binary or packaged installer for non-hacker users (post-hacker-phase); consider Tauri or Electron wrapper for a desktop app.
- [ ] **Multi-instance containers** — per-project agent containers once STT is decoupled from GPU requirement.
- [ ] **TTS/STT one-click setup** — bundle TTS and STT startup into `make start` with graceful no-op fallback when GPU/dependencies are unavailable.
- [ ] **OAT token docs** — document what an OAT token is and how to obtain one (referenced in `.env.example` but unexplained).

---

## 📁 Archive (Implemented Features)
*Moved to keep the active TODO clean. See git history for details.*
- Streaming responses (Anthropic/OpenAI)
- Extended thinking heuristics
- Context compaction
- Multi-provider support
- Self-modification with `tsc --noEmit` gate
- Conversation state auto-save
- Background/sync sub-agents
- 19 Core Tools (`exec`, `read_file`, `fetch`, `patch`, etc.)
- Persistent workspace memory system
- Docker sandbox with `cap_drop ALL`
- Web UI with Push-to-talk, TTS, STT, and Screen capture
- Full MCP client support
- Formal Threat Model documentation (`docs/threat-model.md`)
- Adversarial Red Team analysis (`docs/red-team.md`)