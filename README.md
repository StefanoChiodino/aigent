# aigent

**A self-modifying AI agent platform built for developers and AI researchers.**

The agent runs in a Docker sandbox, can read and edit its own source code, and talks to you through a browser-based UI. API keys never enter the sandbox. All host access is permission-gated.

---

## What it does

- Streams responses from Claude (Anthropic) or GPT (OpenAI) or any OpenAI-compatible endpoint
- Executes shell commands, reads/writes files, searches code, fetches URLs
- Modifies its own source — changes hot-reload, conversation survives restarts
- Maintains persistent memory across sessions (daily logs, curated MEMORY.md, workspace files)
- Proposes changes to host files via patches — you see a diff and approve before anything is written
- Spawns background sub-agents for long tasks without blocking your conversation
- Speaks responses aloud (local TTS) and listens via microphone (local STT)

---

## Architecture

```
Host
├── Gatekeeper (gatekeeper.tsx)
│   ├── Web UI  ←→  Browser
│   ├── Container lifecycle
│   ├── LLM proxy  (API keys never enter sandbox)
│   └── Permission broker  (mounts, capabilities)
│         ↕  NDJSON / Unix socket
└── Docker Sandbox
    ├── agent.ts       — conversation loop, streaming, retry
    ├── provider.ts    — Anthropic + OpenAI abstraction
    ├── tools.ts       — 19 tools
    ├── tasks.ts       — background task queue
    ├── workspace.ts   — memory system
    └── compact.ts     — context compaction
```

**Security model:** Docker with `cap_drop ALL`, `no-new-privileges`, read-only app mount. The gatekeeper is the only process with credentials. The sandbox is disposable.

---

## Quick start

**Requirements:** Docker, Node.js 22+, Anthropic API key (or OAT subscription token)

```bash
git clone <repo> && cd aigent
cp .env.example .env        # add your ANTHROPIC_API_KEY
make start                  # launches gatekeeper + sandbox + web UI
```

Open `http://localhost:3141` in your browser.

For development with auto-rebuild of the web UI and auto-restart of the server on source changes:

```bash
make dev     # tsx --watch-forever + esbuild --watch + TTS/STT
make dev-ts  # same, without TTS/STT services
```

---

## Web UI features

### Voice

- **Push-to-talk** — `Ctrl+\`` or the mic button; transcription streams into the input box in real time
- **Always-on mode** — `Ctrl+Shift+\`` keeps the microphone open continuously; silence detection auto-submits
  - **Interrupt** — talk over the agent's response and VAD will stop it, letting you speak
- **Text-to-speech** — speaker button on each assistant message reads it aloud; auto-speak toggle in the sidebar plays responses automatically
- **Speak preview** — assistant messages with a `<speak>` tag show a chat-bubble icon; hover to see the spoken summary without playing audio
- **Concise mode** — when enabled, a cheap model generates a short spoken summary of each response; only the summary is read aloud, keeping TTS output brief and conversation-paced

### Input

- `Enter` to send, `Shift+Enter` for newline
- `Ctrl+Enter` — one-shot thinking boost (sends with max reasoning, then reverts to current setting)
- `/` to open the slash-command palette with autocomplete
- `@` to open the mention palette — type `@screen` to start screen sharing
- Paste or drag images into the input box; attach files via the paperclip button
- Screen-capture button grabs any window or tab via `getDisplayMedia` and attaches it as an image

### Slash commands

Type `/` to open the command palette. Available commands:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/reset` | Clear conversation and start fresh |
| `/compact` | Manually trigger context compaction |
| `/refresh` | Reload workspace files into the system prompt |
| `/restart` | Restart the sandbox server |
| `/reasoning on\|off` | Toggle extended thinking |
| `/effort low\|medium\|high\|max` | Set thinking budget |
| `/concise on\|off` | Toggle concise/voice mode |
| `/model <name>` | Show or switch the active model |
| `/image <path> [msg]` | Send an image from a sandbox path |
| `/usage` | Show cumulative token and cost stats |
| `/context` | Open the context window inspector |
| `/tasks` | Show background task status |
| `/profiles` | List available profiles |
| `/profile <name>` | Switch to a different profile |
| `/save` | Save the current session |
| `/sessions` | List saved sessions |
| `/load <id>` | Load a saved session |
| `/mount <path> [ro\|rw]` | Mount a host folder into the sandbox |
| `/unmount <path>` | Remove a mount |
| `/mounts` | List active mounts |
| `/grant` / `/deny` | Approve or deny a pending mount request |
| `/approve` / `/reject` | Approve or reject a pending config-write request |
| `/approve-patch` / `/reject-patch` | Approve or reject a pending patch request |

### Reasoning & effort

Toggles in the left sidebar:

| Control | What it does |
|---------|-------------|
| Reasoning on/off | Enable/disable extended thinking |
| Effort level (min → max) | Budget tokens allocated to thinking |

Settings persist across reloads. The agent applies thinking heuristics automatically — short messages get lower effort to save tokens. `Ctrl+Enter` temporarily overrides to max effort for one message.

### Model picker

Choose any available model from the sidebar dropdown. The list is fetched live from the Anthropic API and falls back to a hardcoded default. Selection persists across restarts.

The agent can also switch its own model mid-conversation via the `switch_model` tool — upgrading for complex tasks, downgrading for cheap ones.

### Background tasks

Dispatched via the `dispatch_task` tool. Shown in the sidebar with:

- Live spinner + elapsed time while running
- Context usage (tokens) and model used for each task
- Checkmark / ✗ on completion or failure

Background tasks can use cheaper models (e.g. Haiku for read-only work) to keep costs down. Multiple tasks run in parallel; completed results are injected into the conversation when the agent is next idle.

### Tool visibility

Tool calls are shown inline in the chat — name, input summary, and output excerpt. Collapsed by default; click to expand and see the full input and output.

### Context inspector

Click the context usage bar (in the header or the sidebar) to open the **Context Window** inspector overlay. Also accessible via `/context`. It shows:

- Total estimated token count and percentage of the 200k window used
- A stacked bar chart breaking usage into four components: System prompt, Workspace context, Tool definitions, and Conversation
- A per-component breakdown with individual bars, token counts, and percentages
- A per-message table listing every message in the context with its role and token cost

Each row is expandable — click to reveal the actual content sent to the model:
- **System prompt** — the base instructions text
- **Workspace** — the workspace files section (AGENTS.md, MEMORY.md, etc.)
- **Tool definitions** — name and one-line description of every active tool
- **Messages** — the raw JSON payload for each message (first ~800 characters)

### Mounts

The agent can request access to folders on your machine via the `request_mount` tool. You see a permission modal (with an audio cue and browser notification if the tab is backgrounded), approve or deny, and the agent gets a time-limited mount that auto-expires.

Active mounts are shown in the sidebar with a countdown timer. Click ✕ to revoke early.

You can also grant mounts directly from the chat with `/mount <path> [ro|rw]`.

### Config writes

When the agent wants to edit a workspace config file (SOUL.md, AGENTS.md, USER.md, IDENTITY.md, TOOLS.md), it uses the `request_config_write` tool. You see a modal with the proposed diff; approve to write or reject to cancel.

### Conversation persistence

Messages are saved to `localStorage` (`aigent_chat_history`) on every update and restored immediately on page load, before the WebSocket connects. This means the chat is visible even during server restarts. Messages are cleared on `/reset`.

### Settings

The ⚙ gear icon opens the settings panel. Settings are split into two scopes:

- **Client settings** — stored in `settings.json` on the host, applied immediately (provider, model, tools allowlist, port, STT/TTS URLs, prompt options)
- **Server settings** — stored in `.env`, require a server restart (API keys)

Key settings:

| Setting | Description |
|---------|-------------|
| Provider | Auto-detect, Anthropic, or OpenAI-compatible |
| Anthropic / OpenAI API key | Stored in `.env`, never in `settings.json` |
| OpenAI base URL | For local models (e.g. Ollama, LM Studio) |
| Default model | Model used at startup |
| Disable all tools | Send no tool definitions (useful for local models) |
| Tool allowlist | Comma-separated list of tools to enable |
| Slim prompt | Omit MEMORY.md to save tokens |
| Full session logs | Include complete recent logs in the system prompt |

---

## Memory system

```
/workspace/
├── config/
│   ├── AGENTS.md      — operating instructions (read-only in sandbox)
│   ├── SOUL.md        — personality and values
│   ├── USER.md        — info about you
│   ├── IDENTITY.md    — identity framing
│   └── TOOLS.md       — tool usage notes
├── MEMORY.md          — curated long-term knowledge (freely writable)
└── memory/
    └── YYYY-MM-DD.md  — daily session logs
```

- **Context compaction** at 70% usage — conversation is summarised in place; cost-optimised prompt
- **Cache-aware** — stable system prompt blocks are cached with Anthropic prompt caching; workspace files skip disk reads when unchanged (mtime-based)
- **Memory distillation** — on `/reset` or session end, the agent rewrites `MEMORY.md` from the day's logs
- **Daily logs** — by default only an index of log files is included in the prompt; the agent reads specific logs on demand via `read_file`. Set `AIGENT_FULL_LOGS=1` to include recent logs in full.
- **`search_memory`** — keyword search across all past daily logs at zero LLM cost

### Profiles and sessions

- **Profiles** — separate workspace directories, each with their own config files and memory. Use `/profiles` to list, `/profile create <name>` to create, `/profile <name>` to switch.
- **Sessions** — named save points within a profile. Use `/save`, `/sessions`, and `/load <id>` to manage them.

---

## Tools (19)

| Tool | Description |
|------|-------------|
| `exec` | Shell command with timeout and optional cwd |
| `read_file` | File read with line-range support (offset + limit) |
| `write_file` | Write a file, creating parent directories as needed |
| `edit_file` | Surgical exact-string replacement in a file |
| `patch` | Multiple find-replace edits in one call |
| `list_files` | Directory listing |
| `grep` | Regex search with file/line results |
| `glob` | Recursive file-pattern matching (skips node_modules etc.) |
| `tree` | Directory tree, gitignore-aware |
| `fetch` | HTTP requests (all methods, optional HTML→text stripping) |
| `screenshot` | Capture the sandbox virtual display (Xvfb) as PNG |
| `request_screenshot` | Capture the user's live browser screen (requires screen-share active) |
| `dispatch_task` | Spawn a background agent — returns immediately, result injected later |
| `spawn_agent` | Spawn a sub-agent synchronously — blocks until done |
| `switch_model` | Change active model mid-conversation (upgrade or downgrade) |
| `host` | Call host OS capabilities: clipboard, audio, notifications, open |
| `request_mount` | Ask the user to grant access to a host folder (time-limited) |
| `request_config_write` | Propose edits to config files (SOUL.md, AGENTS.md, etc.) — user sees diff |
| `search_memory` | Keyword search across past session logs (zero LLM cost) |

---

## Configuration

### Environment variables

```bash
ANTHROPIC_API_KEY=sk-ant-...      # or use OAT token
OPENAI_API_KEY=sk-...             # for OpenAI provider
AIGENT_PROVIDER=anthropic         # anthropic | openai (auto-detected if omitted)
AIGENT_MODEL=claude-opus-4-6      # default model
AIGENT_THINKING=medium            # off | low | medium | high | max
AIGENT_WEB_PORT=3141              # web UI port
AIGENT_BASE_URL=...               # OpenAI-compatible base URL (e.g. Ollama)
AIGENT_DEBUG=1                    # verbose logging
AIGENT_SLIM_PROMPT=1              # omit MEMORY.md from system prompt
AIGENT_FULL_LOGS=1                # include recent session logs in full
```

### TTS / STT setup

```bash
make tts-setup   # install edge-tts (Microsoft TTS, no API key needed)
make tts         # start the TTS server on port 8766

# STT uses NVIDIA Parakeet via local Python service
cd stt && pip install -r requirements.txt && python main.py
# Runs on port 8765 by default
```

TTS and STT URLs are configurable in the settings panel or via `AIGENT_TTS_URL` / `AIGENT_STT_URL`.

### MCP (Model Context Protocol)

Add external tool servers in `workspace/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

Tools are automatically prefixed `mcp_<server>_<name>` and appear alongside built-in tools. The MCP client uses JSON-RPC 2.0 over stdio.

---

## Self-modification

The agent's source is mounted at `/app/src/` inside the container. Edits persist on the host filesystem. The file watcher ([worker.ts](src/worker.ts)) polls `src/` every second and, after a 2s debounce, runs `tsc --noEmit` before restarting the server.

```
You:   Add a tool that runs Python snippets and returns stdout
Agent: [reads tools.ts, implements PythonTool, adds to registry, runs tsc, commits]
```

### Safety model

**Typecheck gate** — the server never restarts on bad code. If `tsc --noEmit` fails, the running server is left untouched and the error is logged to `/tmp/aigent-server.log`. The agent sees the failure and can fix it before the change takes effect.

**Rollback** — because the source is a normal git repo on your host, you can always revert agent edits manually:

```bash
git diff src/               # see what the agent changed
git checkout src/<file>     # revert a specific file
git checkout src/           # revert all of src/
```

To trigger a clean restart after reverting: use the `/restart` slash command in the chat.

There is currently no automated rollback or git-stash integration. The typecheck gate plus manual `git checkout` is the intended safety net for now. A more granular self-mod policy (allowlist of files the agent may edit autonomously vs. files requiring human approval) is tracked in TODO.md.

---

## Multi-provider support

- **Anthropic** — Claude models, extended thinking, prompt caching, OAT tokens
- **OpenAI** — GPT models (streaming, tool calls, images)
- **OpenAI-compatible** — any endpoint with an OpenAI-style API (Ollama, LM Studio, etc.) via `AIGENT_BASE_URL`

Provider is auto-detected from the API key format. Override with `AIGENT_PROVIDER=openai`.

---

## Contributing

The most productive way to contribute is to run the agent and ask it to implement something. It can read the codebase, write code, run tests, and commit — treating itself as the development environment.

For security issues, open a private issue rather than a public PR.

---

## License

MIT
