# aigent

**A self-modifying AI agent platform built for developers and AI researchers.**

The agent runs in a Docker sandbox, can read and edit its own source code, and talks to you through a browser-based UI. API keys never enter the sandbox. All host access is permission-gated.

---

## What it does

- Streams responses from Claude (Anthropic) or GPT (OpenAI)
- Executes shell commands, reads/writes files, searches code, fetches URLs
- Modifies its own source — changes hot-reload, conversation survives restarts
- Maintains persistent memory across sessions
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
    ├── tools.ts       — 14 tools
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

---

## Web UI features

### Voice

- **Push-to-talk** — `Ctrl+\`` or the mic button; transcription streams into the input box in real time
- **Always-on mode** — `Ctrl+Shift+\`` keeps the microphone open continuously; silence detection auto-submits
- **Text-to-speech** — speaker button on each assistant message; auto-speak toggle in the sidebar
- **Concise mode** — a cheap model summarises long responses before they're spoken, keeping TTS output brief

### Input

- `Enter` to send, `Shift+Enter` for newline
- `Ctrl+Enter` — one-shot thinking boost (sends with max reasoning, then reverts)
- `/` to open the slash-command menu
- Paste or attach images; screen-capture button grabs any window via `getDisplayMedia`

### Reasoning & effort

Toggles in the left sidebar:

| Toggle | What it does |
|--------|-------------|
| Reasoning on/off | Enable/disable extended thinking |
| Effort level (min → max) | Budget tokens allocated to thinking |

Settings persist across reloads. The agent applies thinking heuristics automatically — short messages get lower effort to save tokens.

### Model picker

Choose any Claude model from the sidebar. The list is fetched live from the Anthropic API and falls back to a hardcoded default. Selection persists across restarts.

The agent can also switch its own model mid-conversation via the `switch_model` tool — upgrading for complex tasks, downgrading for cheap ones.

### Background tasks

Dispatched via the `dispatch_task` tool. Shown in the sidebar with:

- Live spinner + elapsed time while running
- Context usage (tokens) and model used for each task
- Checkmark / ✗ on completion or failure

Background tasks can use cheaper models (e.g. Haiku for read-only work) to keep costs down.

### Tool visibility

Tool calls are shown inline in the chat — name, input summary, and output excerpt. Collapsed by default; expand to see the full result.

Context usage is shown in the status bar: current tokens / context window, with a colour-coded bar.

### Mounts

The agent can request access to folders on your machine via the `request_mount` tool. You see a permission modal (with an audio cue and browser notification if the tab is backgrounded), approve or deny, and the agent gets a time-limited mount that auto-expires.

Active mounts are shown in the sidebar with a countdown. Click ✕ to revoke early.

---

## Memory system

```
/workspace/
├── AGENTS.md        — operating instructions
├── SOUL.md          — personality and values
├── USER.md          — info about you
├── MEMORY.md        — curated long-term knowledge
├── TOOLS.md         — tool notes
└── memory/
    └── YYYY-MM-DD.md  — daily session logs
```

- **Context compaction** at 70% usage — conversation is summarised in place; cost-optimised prompt
- **Cache-aware** — stable system prompt blocks are cached; workspace files skip disk reads when unchanged
- **Memory distillation** — on session end or `/reset`, the agent rewrites `MEMORY.md` from the day's logs

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
AIGENT_MODEL=claude-opus-4-6      # default model
AIGENT_THINKING=medium            # off | low | medium | high | max
AIGENT_WEB_PORT=3141              # web UI port
AIGENT_DEBUG=1                    # verbose logging
```

### TTS / STT setup

```bash
make tts-setup   # install edge-tts (Microsoft TTS, no API key needed)
make tts         # start the TTS server

# STT uses NVIDIA Parakeet via local Python service
cd stt && pip install -r requirements.txt && python main.py
```

---

## Self-modification

The agent's source is mounted at `/app/src/` inside the container. Edits persist on the host filesystem. The file watcher runs `tsc --noEmit` before restarting — bad code doesn't take down the server. Conversation state is auto-saved and restored on restart.

```
You:   Add a tool that runs Python snippets and returns stdout
Agent: [reads tools.ts, implements PythonTool, adds to registry, runs tsc, commits]
```

---

## Multi-provider support

- **Anthropic** — Claude models, extended thinking, prompt caching, OAT tokens
- **OpenAI** — GPT models (streaming, tool calls, images)

Provider is auto-detected from the API key format. Switch with `AIGENT_PROVIDER=openai`.

---

## Contributing

The most productive way to contribute is to run the agent and ask it to implement something. It can read the codebase, write code, run tests, and commit — treating itself as the development environment.

For security issues, open a private issue rather than a public PR.

---

## License

MIT
