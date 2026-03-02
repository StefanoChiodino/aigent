# Self-Modification Architecture

> How the agent edits its own source code, how changes take effect safely, and how the continuous learning system drives autonomous improvement.

## Overview

aigent can read and modify its own source code — `src/`, `web/src/`, and workspace files. Changes persist on the host filesystem immediately. The system ensures safety through a typecheck gate (bad code never runs), three-tier command safety (all agent exec calls are gated), and git-based rollback (revert any change instantly).

This makes aigent a **self-improving system**: it can fix bugs in its own tools, refine its prompts, improve its UI, and adapt its behavior — all while running.

---

## The Edit-Typecheck-Reload Cycle

When the agent edits a source file, the change takes effect through this pipeline:

```
1. Agent edits file (via write_file, edit_file, or patch tool)
         ↓
2. Agent runs /reload (or auto-watch detects mtime change)
         ↓
3. tsc --noEmit  ← typecheck gate
         ↓ pass                    ↓ fail
4. Vite build (if web/src)    Server keeps running.
         ↓                    Error logged. Agent can fix.
5. Server restart
         ↓
6. Client auto-reconnects, conversation continues
```

**Key property:** the server never restarts on broken code. If `tsc --noEmit` fails, the running server is left untouched and the error is logged to `/tmp/aigent-server.log`. The agent sees the failure and can fix the issue before trying again.

---

## Graceful Restart

When auto-watch is enabled and the agent edits its own source mid-turn, the restart is **deferred until the agent finishes its current response**. This prevents the exact scenario that motivated this design: the agent edits a file, the watcher detects the change, restarts the server, and the user never gets a response.

How it works:

1. The gatekeeper tracks whether the agent is mid-turn via `loading` events from the server
2. When a file change is detected and typecheck passes:
   - **If agent is idle:** restart immediately (same as before)
   - **If agent is busy:** set a `pendingRestart` flag and notify the user via system message
3. When the agent's turn completes (`loading: false`), the deferred restart executes automatically
4. A 120-second safety timeout forces restart if the agent is stuck in an exceptionally long turn

The same deferral logic applies to the manual `/reload` command — typecheck and build run immediately, but the actual server restart waits for the agent to finish.

---

## Manual `/reload` vs Auto-Watch

### `/reload` (default workflow)

The recommended approach during development. The agent (or user) explicitly triggers a reload after editing source files:

```
/reload  →  typecheck  →  vite build  →  restart (deferred if busy)
```

Progress is shown step by step in the chat. This is the default in `make dev` and `make dev-ts`.

### Auto-watch (opt-in)

Enable with the `--watch` flag or `AIGENT_AUTO_RELOAD=1`:

```bash
make dev-ts ARGS="--watch"     # or
AIGENT_AUTO_RELOAD=1 make dev  # or
npx tsx src/gatekeeper.tsx --headless --watch
```

The file watcher polls `src/` and `web/src/` every second. After a 2-second debounce (to handle multi-file edits), it runs the same typecheck → build → restart pipeline. Restarts are deferred when the agent is busy.

**Why opt-in:** Auto-watch is convenient but can surprise you when the agent self-modifies during a conversation. The graceful restart deferral mitigates this, but manual `/reload` gives you full control over when changes take effect.

---

## Safety Model

### Typecheck Gate

Every reload path (auto-watch and `/reload`) runs `tsc --noEmit` before restarting. Type errors block the restart completely. The server keeps running with the old code.

### Three-Tier Command Safety

All `exec` calls the agent makes during self-modification — `git commit`, `npx tsc`, `npm test` — go through the same three-tier safety pipeline as any other command:

| Tier | Gate | Override? |
|------|------|-----------|
| **1 — Hard deny** | Shell injection, credential paths, destructive ops | No |
| **2 — Static allow/deny** | Glob patterns from settings.json | User-configurable |
| **3 — Haiku classifier** | LLM evaluation of ambiguous commands | Fallback to user prompt |

### Config File Protection

Source files in `src/` and `web/src/` can be edited freely. Workspace config files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md) require explicit user approval via the `request_config_write` tool — the user sees a diff and approves or rejects.

### Git-Based Rollback

The source is a normal git repo. Revert any agent edit:

```bash
git diff src/               # see what changed
git checkout src/<file>     # revert a specific file
git checkout src/           # revert all of src/
```

For catastrophic self-breakage, `make recover` auto-bisects to the last working commit.

---

## Continuous Learning and Self-Improvement

Self-modification is most powerful when combined with the continuous learning system. The agent doesn't just edit code randomly — it learns from experience and makes targeted improvements.

### The Improvement Loop

```
Session N
  └─ User interaction → episodes logged (outcome, friction, lessons)
       └─ Feedback: star ratings, tool failures, error signals
            └─ Semantic index updated (local neural embeddings)

Session end / /reset
  └─ Reflection agent analyzes last 50 episodes
       └─ Finds: recurring friction, success patterns, cost anomalies
            └─ Writes insights to MEMORY.md (feeds next session's system prompt)
            └─ Writes improvement suggestions to TODO.md

Session N+1
  └─ Agent reads MEMORY.md → sees past lessons before responding
  └─ Semantic retrieval surfaces relevant episodes (similarity > 0.4)
  └─ Agent can act on insights: edit source, refine prompts, fix tools
       └─ /reload → typecheck → graceful restart → continues with improved code
```

### What the Agent Can Improve

| Area | Files | Example |
|------|-------|---------|
| Tool implementations | `src/tools/` | Fix a tool that keeps failing |
| Agent behavior | `src/agent.ts` | Improve retry logic after seeing timeout patterns |
| System prompts | `workspace/config/` | Refine instructions (via `request_config_write`) |
| UI components | `web/src/` | Fix a rendering bug it observed via browser extension |
| Compaction | `src/compact.ts` | Improve context summaries that were losing details |
| Its own memory | `workspace/MEMORY.md` | Curate long-term knowledge |

### Measuring Improvement

The episode system provides built-in metrics:

- **Success rate** — proportion of episodes with positive outcomes over time
- **Friction tracking** — recurring friction points that decrease after fixes
- **Cost trends** — token usage per task type, tracked across sessions
- **User ratings** — 1-5 star scores on agent messages, averaged into episodes

Query with `query_episodes` (structured filters) or `search_episodes` (semantic similarity).

---

## Dev Workflow

### Standard development (recommended)

```bash
make dev-ts          # start without auto-watch
# ... agent edits source ...
# agent runs /reload, or you type /reload in chat
```

### With auto-watch

```bash
make dev-ts ARGS="--watch"
# file watcher handles reloads automatically
# graceful: waits for agent to finish if mid-turn
```

### Verifying changes

```bash
make check           # typecheck + unit tests + web tests + build
```

### Recovery

```bash
make recover         # auto-bisect to last working commit
```
