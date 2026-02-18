# Host Daemon — Design Doc

> A thin host-side process that exposes OS capabilities to the sandboxed agent,
> gated by an explicit permission model.

## Problem

The agent runs inside Docker — no access to clipboard, audio, display, or
anything outside its mounted volumes. Some capabilities fundamentally require
host access. Piping everything through Docker volume mounts doesn't scale and
can't cover interactive resources (microphone, speakers, screen).

## Approach

A minimal daemon runs on the host. The sandboxed agent connects to it over a
Unix socket (mounted into the container). The daemon exposes a fixed set of
**capabilities**, each gated by a **permission grant**. The daemon has no AI
logic — it's a pure bridge between the sandbox and the host OS.

```
┌─────────────────────────────────────────────┐
│ Docker container                            │
│                                             │
│   supervisor.tsx                            │
│     ├── server.ts (agent, tools, etc.)      │
│     │     └── host-client.ts ←──────────┐   │
│     └── TUI (ink)                       │   │
│                                         │   │
└─────────────────────────────────────┬───│───┘
                                      │   │
                           /tmp/aigent-host.sock
                                      │   │
┌─────────────────────────────────────┴───│───┐
│ Host                                    │   │
│                                         │   │
│   aigent-host (daemon)                  │   │
│     ├── capability registry             │   │
│     ├── permission store ───────────────┘   │
│     └── providers/                          │
│           ├── clipboard.ts                  │
│           ├── audio.ts                      │
│           ├── screen.ts                     │
│           └── fs.ts                         │
└─────────────────────────────────────────────┘
```

## Capabilities

Each capability is a namespaced action. Initial set:

| Capability          | Description                        | Returns              |
|---------------------|------------------------------------|----------------------|
| `clipboard.read`    | Read clipboard (text or image)     | text or base64 image |
| `clipboard.write`   | Write to clipboard                 | ok                   |
| `audio.play`        | Play audio file or TTS stream      | ok                   |
| `audio.record`      | Record from microphone             | base64 audio         |
| `screen.capture`    | Screenshot (full or region)        | base64 image         |
| `screen.list`       | List windows/displays              | window list          |
| `fs.read`           | Read file outside sandbox          | file content         |
| `fs.write`          | Write file outside sandbox         | ok                   |
| `notify`            | OS notification (toast/alert)      | ok                   |
| `open`              | Open URL/file in default app       | ok                   |

Capabilities are added by dropping a provider file — the registry auto-discovers
them. Not all capabilities need to exist on every platform.

## Permission Model

Inspired by mobile OS permission prompts. Each capability has a **grant level**:

| Grant        | Behaviour                                                  |
|--------------|------------------------------------------------------------|
| `allow`      | Always allowed, no prompt. Persists across sessions.       |
| `session`    | Allowed for this agent session. Revoked on exit.           |
| `prompt`     | Ask the user every time (daemon shows a terminal prompt).  |
| `timed`      | Allowed for N seconds from first grant.                    |
| `deny`       | Always denied. Agent gets a clean error.                   |

**Defaults:** Everything starts as `prompt`. The user opts in explicitly.

**Configuration** lives in a file on the host (not in the container):

```yaml
# ~/.config/aigent/permissions.yaml
capabilities:
  clipboard.read: session
  clipboard.write: prompt
  audio.play: allow
  audio.record: timed  # default 300s
  screen.capture: prompt
  fs.read: deny
  fs.write: deny
  notify: allow
  open: prompt
```

Can also be set via CLI flags:

```bash
aigent-host --allow clipboard.read,notify --deny fs.read,fs.write
```

### Prompt UX

When a capability is set to `prompt`, the daemon prints to its own terminal:

```
[aigent-host] Agent requests: clipboard.read
  Reason: "User asked me to check their clipboard"
  Allow? [y]es / [n]o / [s]ession / [a]lways >
```

The agent call blocks until the user responds. Timeout (30s default) → deny.

## Protocol

NDJSON over Unix socket, consistent with the existing server↔TUI protocol.

### Request (agent → daemon)

```json
{
  "id": "req_01",
  "capability": "clipboard.read",
  "params": {},
  "reason": "User asked me to paste their screenshot"
}
```

The `reason` field is optional. When present, it's shown to the user on
`prompt` grants so they can make an informed decision.

### Response (daemon → agent)

```json
{
  "id": "req_01",
  "ok": true,
  "result": {
    "type": "image",
    "mediaType": "image/png",
    "data": "<base64>"
  }
}
```

Error:

```json
{
  "id": "req_01",
  "ok": false,
  "error": "denied",
  "message": "clipboard.read permission denied by user"
}
```

### Events (daemon → agent, unsolicited)

```json
{ "event": "permission_changed", "capability": "clipboard.read", "grant": "allow" }
```

## Integration with Agent

### New tool: `host`

A single tool that wraps all host daemon calls. The agent calls it like any
other tool:

```json
{
  "name": "host",
  "input": {
    "capability": "clipboard.read",
    "reason": "User wants to discuss their screenshot"
  }
}
```

The tool implementation (`host-client.ts`) sends the request over the socket
and returns the result. If the daemon isn't running, the tool returns a clear
error: "Host daemon not connected. Start it with: aigent-host".

### System prompt awareness

The agent's system prompt includes:

```
Host capabilities available: clipboard.read, clipboard.write, audio.play, notify
Host capabilities denied: fs.read, fs.write
Host daemon: connected
```

This lets the agent know what it can and can't do without trial-and-error.

## Daemon Implementation

### Startup

```bash
# Simple — just start it
aigent-host

# With permissions
aigent-host --allow clipboard.read,notify --deny fs.write

# Custom socket path (for multiple agents)
aigent-host --socket /tmp/aigent-host-2.sock
```

The daemon:
1. Loads `~/.config/aigent/permissions.yaml` (creates default if missing)
2. Applies CLI overrides
3. Discovers available capability providers for the current platform
4. Listens on Unix socket
5. Logs activity to stderr

### Platform detection

The daemon detects the host platform and loads appropriate providers:

- **Linux/X11:** `xclip`, `xdotool`, `scrot`
- **Linux/Wayland:** `wl-paste`, `wl-copy`, `grim`
- **macOS:** `pbpaste`, `pbcopy`, `screencapture`
- **WSL2:** `powershell.exe` for clipboard, Windows APIs for screen

Missing tools → capability marked unavailable (not an error, just not offered).

### Docker integration

The socket is mounted into the container:

```yaml
# docker-compose.yml
volumes:
  - /tmp/aigent-host.sock:/tmp/aigent-host.sock
```

The agent detects the socket at startup. If present → host capabilities
available. If absent → agent works fine, just without host features.

## Implementation Plan

### Phase 1: Socket + permissions + clipboard (MVP)

1. **`aigent-host` CLI** — Node.js, socket listener, permission store,
   prompt UX
2. **Clipboard provider** — platform-detected, read (text + image) and write
3. **`host-client.ts`** in agent — socket client, request/response
4. **`host` tool** — wired into tools.ts
5. **Docker compose** — conditional socket mount
6. **System prompt** — advertise available/denied capabilities

### Phase 2: Screen + audio

7. Screen capture provider
8. Audio play provider (pipe to host speakers)
9. Audio record provider

### Phase 3: Extended

10. `notify` and `open` providers
11. External filesystem access (with path restrictions in permission config)
12. Timed permissions with automatic expiry
13. Permission management UI (TUI command: `/permissions`)

## Security Considerations

- The daemon runs as the host user — it has full host access. The permission
  model is about **agent control**, not sandboxing the daemon.
- The socket file should be user-readable only (`0600`).
- `reason` strings from the agent are untrusted — displayed to the user but
  never executed.
- `fs.read`/`fs.write` are `deny` by default for good reason. If enabled,
  the permission config should support path allowlists.
- The daemon should refuse to start as root.

## Non-Goals

- The daemon is not a gateway for API keys (that's a separate concern).
- The daemon doesn't manage the Docker container lifecycle.
- No remote access — Unix socket only. (TCP bridge is a future extension if
  we want remote agent → local host.)
