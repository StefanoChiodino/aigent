# Core System Specification

## Overview

aigent is a self-authoring AI agent that runs as a child process on the host, with a gatekeeper enforcing least-privilege access via a three-tier command safety system. It features a web UI interface, Chrome extension, VSCode integration, STT/TTS audio systems, and browser automation capabilities.

## System Architecture

### Core Components

#### 1. CLI Entry Points (src/cli.ts, src/supervisor.tsx)

**src/cli.ts** - Command dispatcher
- Dispatches `aigent init` (setup wizard) or `aigent [options]` (start agent)
- Thin dispatcher; all logic in gatekeeper.tsx/init.ts
- Supports `--workspace`, `--model`, `--provider`, `--headless` flags

**src/supervisor.tsx** - Primary entry point
- Starts server as background child process
- Runs web UI server (non-blocking)
- Runs TUI in-process for direct TTY access (legacy, deprecated)
- Conversation auto-saves on every response
- `/restart` command triggers clean server restart
- No auto-reloading — explicit, user-controlled restarts

#### 2. Gatekeeper (src/gatekeeper.tsx)

Host process that manages agent execution:
- Spawns server process directly (no Docker/sandbox)
- Enforces three-tier command safety system
- LLM proxy (API keys never enter server process)
- Web UI bridge (WebSocket ↔ Unix socket)
- OS bridge (clipboard, audio, screen)
- File watcher for self-modification auto-restart
- Manages Chrome extension and VSCode extension bridges

#### 3. Server Process (src/server.ts)

Agent runtime that runs as child of supervisor:
- Conversation loop, tool dispatch, streaming
- Socket client connecting to gatekeeper
- Direct host filesystem access (all writes go through gatekeeper approval)
- All shell commands go through three-tier safety system
- WebSocket server for web UI and extensions

#### 4. Agent Core (src/agent.ts, src/client.ts)

- Main agent logic and state management
- LLM conversation loop, streaming, sub-agents
- WebSocket client for TUI connection
- Auto-reconnect, command queue
- Context compaction and memory management

#### 5. LLM Provider (src/provider.ts, src/llm-proxy.ts, src/socket-provider.ts)

- Abstract LLM interface supporting multiple providers
- Anthropic, OpenAI, and local model support
- Token management and context handling
- Provider factory + auto-detection
- Cost tracking and pricing models

#### 6. Tools System (src/tools/defs.ts, src/tools/execute.ts)

- Tool definition registry
- Tool execution engine with safety checks
- Built-in tools: exec, read_file, write_file, edit_file, list_files, grep, glob, fetch, tree, patch, spawn_agent, screenshot, dispatch_task, host, request_config_write, host_edit_file, switch_model, browser_ext, ask_user, log_episode, query_episodes, speak_text
- Bidirectional mapping to Claude Code tool names
- Browser automation tools (extract_a11y, screenshot, run_script, navigate, list_tabs, activate_tab, open_tab, close_tab, devtools_start, devtools_snapshot, devtools_stop)

#### 7. Web Interface (web/src/main.tsx, web/src/components/)

- React-based web UI (Vite + vanilla TS)
- WebSocket connection to backend
- Chat interface with message history
- Components: App, Header, InputArea, Message, Sidebar, AtPalette, CommandPalette, ChatArea, AttachmentPreview, KeyCaptureButton, QueueChips, RatingWidget, SpeakPreview, StreamingMessage, TraceBlock
- 14 background components (Chroma, Circuit, Constellation, Ember, Fireflies, LavaLamp, Matrix, Milkdrop, NeonGrid, Neuron, Oscilloscope, PCB, Rain, Spectrum, Topology)
- 11 modal components (ContextInspector, DiffViewer, PermissionModal, QuestionModal, SettingControl, SettingsModal, ShortcutsModal, TaskResultPanel, TasksInspector, TraceInspector)
- State stores (chat, connection, rating, settings, ui, voice)
- Custom hooks (useAudioAnalysis, useMic, usePiP, useTTS, useWakeLock, useWebSocket, ws-handlers)

#### 8. Chrome Extension (aigent-extension/)

- Browser extension with popup interface
- Background service worker (MV3) with keepalive alarms
- WebSocket bridge to agent server at ws://localhost:3141/ext
- Browser automation tools:
  - extract_a11y: Extract accessibility tree from active tab
  - screenshot: Capture tab screenshot as data URL
  - run_script: Execute multi-step browser automation scripts
  - navigate: Navigate to URL
  - list_tabs: List all tabs with metadata
  - activate_tab, open_tab, close_tab: Tab management
  - create_window: Create dedicated agent browsing window
  - devtools_start/stop/snapshot: CDP DevTools integration
- Session-based auth via /ext/secret endpoint
- CDP integration for network, console, performance monitoring
- Tab and window tracking for agent sessions

#### 9. VSCode Extension (vscode-extension/)

- Activity bar panel with full web UI
- Status bar connection indicator
- WebSocket bridge to agent server
- Session-based auth via /ext/secret endpoint
- Sends vscode_context (visible files, active file, selection) to server
- Supports file operations and editor integration

#### 10. STT System (stt/)

- Speech-to-Text server using sherpa-onnx Whisper models
- Legacy Parakeet support (nvidia/parakeet-tdt-0.6b-v2) for existing users
- HTTP API at stt/server.mjs (default port 8765)
- POST /transcribe: Raw WAV bytes → transcribed text
- GET /health: Status check with model info
- Auto-detects model directory (whisper or zipformer)
- Energy threshold gate to skip silent audio
- Idle timeout for model unloading
- Supports int8 quantized models for performance

#### 11. TTS System (tts/)

- Text-to-Speech server using edge-tts (Microsoft Edge neural TTS)
- No API key required
- HTTP API at tts/main.py (default port 8766)
- POST /synthesize: Plain text → MP3 audio
- Per-request voice/rate/pitch overrides via query params
- Default voice: en-US-AvaNeural
- Supports rate (+25% default) and pitch (+0Hz default) adjustments

#### 12. Host Integration (src/host/)

- OS-level integration layer
- daemon.ts: Host daemon process
- permissions.ts: Host permission management
- protocol.ts: Host-protocol communication
- providers/clipboard.ts: Clipboard access provider

#### 13. Memory & Learning System

- Episodes system (episodes.ts, episode-index.ts): Task outcome logging and retrieval
- Reflection system (reflection.ts): Flash-model pattern mining
- Embeddings (embeddings.ts): Local neural embeddings for semantic search
- Context compaction (compact.ts): Automatic context window management
- Profile/session management (profiles.ts): Multi-profile support with auto-save/load

#### 14. Safety & Security

- Three-tier permission system (read, write, execute)
- Browser safety checks (browser-safety.ts, browser-perms.ts)
- Audit logging (audit.ts, tool-log.ts)
- Pricing/cost tracking (pricing.ts)
- Usage tracking (usage-tracking.ts)

### Data Flow

```
User Input → Web UI (web/src/main.tsx) → WebSocket → Gatekeeper (src/gatekeeper.tsx)
                                                    ↓
                                            Three-tier safety
                                                    ↓
                                          Server Process (src/server.ts)
                                                    ↓
                                          Agent Core (src/agent.ts)
                                                    ↓
                                          Tools → Results → UI Update

Chrome Extension: Browser → WebSocket (/ext) → Gatekeeper → Server → Browser automation
VSCode Extension: VSCode → WebSocket (/ext) → Gatekeeper → Server → File operations
STT: Audio Input → sherpa-onnx → Text → Agent
TTS: Text → edge-tts → MP3 Audio → Speaker
```

### Key Features

1. **Real-time Communication**: Unix socket (NDJSON) + WebSocket-based bidirectional communication
2. **Safety First**: Three-tier permission system (read, write, execute) with software-enforced boundaries
3. **Context Management**: Automatic context compaction and memory management
4. **Multi-Model Support**: Abstract LLM interface for provider switching
5. **Extensible Tools**: 21+ tools with Claude Code mapping and browser automation
6. **Self-Modifying Codebase**: File watcher triggers explicit server restarts
7. **Multi-Platform**: Web UI, Chrome extension, VSCode extension, TUI (legacy)
8. **Audio Integration**: STT (Whisper/Parakeet) + TTS (Edge neural)
9. **Browser Automation**: Full CDP integration with DevTools monitoring
10. **Episode Memory**: Task logging, retrieval, and flash-pattern mining
11. **Cost Tracking**: Real-time pricing and usage monitoring

## Technical Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict mode, ESM), Python 3.x (STT/TTS)
- **UI**: React with Vite (web), Ink (TUI - legacy), Chrome extension, VSCode extension
- **Communication**: Unix socket (NDJSON over /tmp/aigent/worker.sock), WebSocket (ws://)
- **STT**: sherpa-onnx (Whisper/Zipformer), Parakeet (legacy)
- **TTS**: edge-tts (Microsoft Edge neural TTS)
- **Browser Automation**: Playwright, CDP (Chrome DevTools Protocol)
- **Testing**: Vitest, Playwright for E2E

## Security Model

### Three-Tier Safety System

Software-enforced safety boundaries (no Docker/sandbox):

1. **Tier 1: Static Deny** — instant block, no model call
   - Shell injection ($(), backticks, eval, source)
   - Credential access (~/.ssh/*, ~/.aws/*)
   - System destruction (rm -rf /, mkfs, dd of=/dev/)
   - Privilege escalation (sudo, su)
   - Exfiltration (curl ... | bash, wget ... | bash)

2. **Tier 2: Static Allow/Deny** — instant, from settings.json
   - Glob-based pattern matching
   - ~40 default safe patterns (git read ops, ls, cat, npm test)
   - User-extensible with --always flag

3. **Tier 3: LLM Classifier** — for ambiguous commands (~200ms, ~$0.001/call)
   - Returns allow/block/ask with reason
   - LRU cache (200 entries, 5-min TTL)
   - "ask" shows user command + classifier assessment
   - Disable with AIGENT_CLASSIFIER=0

### Permission Files

Specialized gatekeeper permission modules:

- **src/gk-exec-perms.ts** — Exec command approvals
- **src/gk-fetch-perms.ts** — Fetch URL approvals
- **src/gk-file-perms.ts** — File access approvals
- **src/gk-mcp-perms.ts** — MCP tool approvals
- **src/gk-config-writes.ts** — Config file write approvals
- **src/gk-perm-utils.ts** — Permission utilities

### API Key Isolation

- API keys held by gatekeeper, never enter server process
- `sanitizedEnv()` strips keys from server environment
- Even compromised agent cannot exfiltrate credentials

### Prompt Injection Defense

- Three-tier safety blocks malicious commands
- Config protection (SOUL.md, AGENTS.md) requires gatekeeper approval with diff
- External content wrapped in untrusted markers
- Base prompt instructs model to ignore adversarial instructions

## Directory Structure

```
aigent/
├── src/                          # Core agent code (97 files)
│   ├── cli.ts                    # CLI dispatcher (init, start)
│   ├── index.tsx                 # TUI client (frontend only, legacy)
│   ├── supervisor.tsx            # Starts server + runs TUI (primary entry)
│   ├── gatekeeper.tsx            # Host process, safety engine, web bridge
│   ├── server.ts                 # Agent runtime, conversation loop
│   ├── agent.ts                  # LLM conversation loop, streaming
│   ├── client.ts                 # Socket connector, auto-reconnect
│   ├── provider.ts               # LLM provider abstraction
│   ├── llm-proxy.ts              # LLM API proxy (holds keys)
│   ├── socket-provider.ts        # Socket-based provider
│   ├── tools/                    # Tool definitions + execution
│   │   ├── defs.ts               # Tool registry (21+ tools)
│   │   ├── execute.ts            # Tool execution engine
│   │   └── index.ts              # Tool index
│   ├── safety.ts                 # Three-tier safety checks
│   ├── gk-exec-perms.ts          # Exec command approvals
│   ├── gk-fetch-perms.ts         # Fetch URL approvals
│   ├── gk-file-perms.ts          # File access approvals
│   ├── gk-mcp-perms.ts           # MCP tool approvals
│   ├── gk-config-writes.ts       # Config write handling
│   ├── gk-perm-utils.ts          # Permission utilities
│   ├── protocol.ts               # Message types, socket paths
│   ├── web-bridge.ts             # Web UI HTTP + WebSocket server
│   ├── ext-bridge.ts             # Extension bridge
│   ├── host-client.ts            # Host client bridge
│   ├── xdg.ts                    # XDG directory handling
│   ├── workspace.ts              # Memory system
│   ├── profiles.ts               # Multi-profile, sessions
│   ├── compact.ts                # Context compaction
│   ├── commands.ts               # Slash command handlers
│   ├── classifier.ts             # Haiku command classifier (Tier 3)
│   ├── auth.ts                   # API key / OAT token handling
│   ├── mcp.ts                    # MCP client over stdio
│   ├── browser-safety.ts         # Browser action safety
│   ├── browser-perms.ts          # Browser permission handling
│   ├── pricing.ts                # Cost tracking
│   ├── usage-tracking.ts         # Lifetime token tracking
│   ├── episodes.ts               # Episode logging
│   ├── episode-index.ts          # Episode index management
│   ├── reflection.ts             # Flash-model pattern mining
│   ├── embeddings.ts             # Local neural embeddings
│   ├── audit.ts                  # Audit logging
│   ├── tool-log.ts               # Tool execution logging
│   ├── req-context.ts            # Request context
│   ├── pending-request.ts        # Pending request broker
│   ├── image-support.ts          # Image handling
│   ├── diff.ts                   # Diff utilities
│   ├── logger.ts                 # Logging utilities
│   ├── log-rotate.ts             # Log rotation
│   ├── system-prompts.ts         # System prompt templates
│   ├── settings-file.ts          # Settings file handling
│   ├── tasks.ts                  # Background task queue
│   ├── init.ts                   # Setup wizard
│   ├── repl.ts                   # REPL fallback (non-TTY)
│   ├── host/                     # Host integration
│   │   ├── daemon.ts             # Host daemon process
│   │   ├── permissions.ts        # Host permission management
│   │   ├── protocol.ts           # Host-protocol communication
│   │   └── providers/            # OS providers
│   │       └── clipboard.ts      # Clipboard access
│   ├── ui/                       # TUI components (legacy)
│   │   ├── App.tsx               # TUI root
│   │   ├── ChatView.tsx          # TUI chat
│   │   ├── InputBar.tsx          # TUI input
│   │   ├── TextInput.tsx         # TUI text input
│   │   ├── Markdown.tsx          # TUI markdown rendering
│   │   └── AnsiTUI.ts            # TUI renderer
│   ├── web/                      # Web server (backend)
│   │   └── server.ts             # Web backend server
│   ├── types/                    # TypeScript declarations
│   │   └── marked-terminal.d.ts  # marked-terminal types
│   ├── workspace-templates/      # Workspace templates
│   └── [test files]              # Unit tests
├── web/                          # Web UI (Vite + vanilla TS)
│   ├── src/
│   │   ├── main.tsx              # Main entry point
│   │   ├── types.ts              # TypeScript definitions
│   │   ├── components/           # React components (15 main)
│   │   │   ├── App.tsx
│   │   │   ├── Header.tsx
│   │   │   ├── InputArea.tsx
│   │   │   ├── Message.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── AtPalette.tsx
│   │   │   ├── CommandPalette.tsx
│   │   │   ├── ChatArea.tsx
│   │   │   ├── AttachmentPreview.tsx
│   │   │   ├── KeyCaptureButton.tsx
│   │   │   ├── QueueChips.tsx
│   │   │   ├── RatingWidget.tsx
│   │   │   ├── SpeakPreview.tsx
│   │   │   ├── StreamingMessage.tsx
│   │   │   ├── TraceBlock.tsx
│   │   │   ├── backgrounds/      # 14 background components
│   │   │   │   ├── ChromaBackground.tsx
│   │   │   │   ├── CircuitBackground.tsx
│   │   │   │   ├── ConstellationBackground.tsx
│   │   │   │   ├── EmberBackground.tsx
│   │   │   │   ├── FirefliesBackground.tsx
│   │   │   │   ├── LavaLampBackground.tsx
│   │   │   │   ├── MatrixBackground.tsx
│   │   │   │   ├── MilkdropBackground.tsx
│   │   │   │   ├── NeonGridBackground.tsx
│   │   │   │   ├── NeuronBackground.tsx
│   │   │   │   ├── OscilloscopeBackground.tsx
│   │   │   │   ├── PCBBackground.tsx
│   │   │   │   ├── RainBackground.tsx
│   │   │   │   ├── SpectrumBackground.tsx
│   │   │   │   └── TopologyBackground.tsx
│   │   │   └── modals/           # 11 modal components
│   │   │       ├── ContextInspector.tsx
│   │   │       ├── DiffViewer.tsx
│   │   │       ├── PermissionModal.tsx
│   │   │       ├── QuestionModal.tsx
│   │   │       ├── SettingControl.tsx
│   │   │       ├── SettingsModal.tsx
│   │   │       ├── ShortcutsModal.tsx
│   │   │       ├── TaskResultPanel.tsx
│   │   │       ├── TasksInspector.tsx
│   │   │       ├── TraceInspector.tsx
│   │   │       └── TraceInspector.tsx
│   │   ├── stores/               # State stores (6)
│   │   │   ├── chat.ts
│   │   │   ├── connection.ts
│   │   │   ├── rating.ts
│   │   │   ├── settings.ts
│   │   │   ├── ui.ts
│   │   │   └── voice.ts
│   │   ├── hooks/                # Custom hooks (7)
│   │   │   ├── useAudioAnalysis.ts
│   │   │   ├── useMic.ts
│   │   │   ├── usePiP.ts
│   │   │   ├── useTTS.ts
│   │   │   ├── useWakeLock.ts
│   │   │   ├── useWebSocket.ts
│   │   │   └── ws-handlers.ts
│   │   ├── lib/                  # Utility libraries (11)
│   │   │   ├── audio-devices.ts
│   │   │   ├── audio.ts
│   │   │   ├── broadcastSync.ts
│   │   │   ├── capabilities.ts
│   │   │   ├── diff.ts
│   │   │   ├── errorRelay.ts
│   │   │   ├── keybindings.ts
│   │   │   ├── markdown.ts
│   │   │   ├── notifications.ts
│   │   │   ├── screen.ts
│   │   │   └── settings-schema.ts
│   │   ├── demo/                 # Demo data & playback
│   │   │   ├── DemoPlaybackEngine.ts
│   │   │   ├── DemoScrubber.tsx
│   │   │   ├── MockWebSocket.ts
│   │   │   ├── demoStore.ts
│   │   │   ├── scenario.ts
│   │   │   ├── types.ts
│   │   │   └── useDemoMode.ts
│   │   └── __tests__/            # Web component tests (22)
│   └── style.css                 # Global styles
├── aigent-extension/             # Chrome browser extension (MV3)
│   ├── background/
│   │   └── worker.ts             # Service worker (keepalive alarms)
│   ├── popup/
│   │   ├── popup.html            # Popup UI
│   │   └── popup.ts              # Popup logic
│   ├── pip/                      # Picture-in-picture support
│   ├── manifest.json             # MV3 manifest
│   ├── build.mjs                 # Build script
│   └── icons/                    # Extension icons
├── vscode-extension/             # VSCode extension
│   ├── src/
│   │   └── extension.ts          # Extension entry point
│   ├── package.json              # Extension manifest
│   └── out/                      # Compiled output
├── stt/                          # Speech-to-Text system
│   ├── server.mjs                # sherpa-onnx STT server (default)
│   ├── main.py                   # Parakeet STT server (legacy)
│   ├── download-model.sh         # Model download script
│   ├── requirements.txt          # Python dependencies
│   └── [model directories]       # sherpa-onnx-* models (whisper/zipformer)
├── tts/                          # Text-to-Speech system
│   ├── main.py                   # edge-tts TTS server
│   └── requirements.txt          # Python dependencies
├── tests/                        # E2E tests (Playwright)
│   ├── playwright.config.ts
│   └── [spec files]              # 64+ E2E test specs
├── docs/                         # Documentation (25+ docs)
│   ├── PLAN.md                   # Development roadmap
│   ├── architecture.md           # Full architecture docs
│   ├── tui-architecture.md       # TUI architecture
│   ├── web-ui-architecture.md    # Web UI architecture
│   ├── memory-architecture.md    # Memory system design
│   ├── self-modification.md      # Self-modification strategy
│   ├── threat-model.md           # Security threat model
│   ├── image-handling.md         # Image support design
│   ├── mcp-tool-shortening.md    # MCP integration
│   ├── workspace-design.md       # Workspace design
│   ├── voice-interface.md        # Voice interface design
│   ├── dependency-philosophy.md  # Dependency management
│   ├── host-daemon.md            # Host daemon design
│   ├── design-browser-extension.md # Browser extension design
│   ├── design-continuous-learning.md # Continuous learning
│   ├── design-headless-browser.md # Headless browser
│   ├── design-observability.md   # Observability design
│   ├── explore-agent-orchestration.md # Agent orchestration
│   ├── explore-computer-use.md   # Computer use exploration
│   ├── explore-memory-architecture.md # Memory architecture
│   ├── red-team.md               # Red teaming guidelines
│   ├── max-tokens-settings.md    # Max tokens configuration
│   ├── per-model-max-tokens.md   # Per-model max tokens
│   ├── secret-management.md      # Secret management
│   └── implementation/           # Implementation guides
├── openspec/                     # Spec-driven development
│   ├── specs/                    # System specifications
│   │   └── core/
│   │       └── spec.md         # Core system spec
│   └── changes/                  # Proposed changes
│       └── initial-aigent-spec/
│           ├── design.md
│           ├── proposal.md
│           └── tasks.md
├── scripts/                      # Build scripts
│   ├── gen-demo-audio.py         # Demo audio generation
│   └── recover.sh              # Recovery scripts
├── dist/                         # Compiled output
├── workspace-templates/          # Workspace templates
├── .github/                      # GitHub workflows
├── .claude/                      # Claude config
├── .env.example                  # Environment template
├── Makefile                      # Build commands
├── package.json                  # Dependencies and scripts
└── tsconfig.json                 # TypeScript config
```

## Usage Patterns

### Development Mode

```bash
make dev        # Start development server (tsx --watch src/index.tsx)
make check      # Typecheck + tests + builds
```

### Production Build

```bash
make build      # Build TypeScript + web UI
make package    # Package VSCode extension
```

### Testing

```bash
make test       # Run unit tests (node --import tsx/esm --test src/**/*.test.ts)
make test-e2e   # Run E2E tests with Playwright
make test-llm   # Integration test with local LLM
```

### CLI Usage

```bash
aigent init [workspace-path]   # First-run setup wizard
aigent [options]               # Start the agent (default)

Options (passed to gatekeeper):
  --always-allow <pattern>     # Add to static allow list
  --always-deny <pattern>      # Add to static deny list
  --no-classifier              # Disable Tier 3 classifier
```

## Future Roadmap

See [docs/PLAN.md](../../docs/PLAN.md) for detailed roadmap including:
- Browser automation integration (Phase 3c)
- STT/TTS enhancements
- Multi-instance agent support
- Enhanced safety features
- Semantic episode retrieval
- Flash-filtered retrieval
- RAG with local embeddings
