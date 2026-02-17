# Workspace Design

## Problem

LLM context is finite. Agents forget everything between sessions. Without persistent memory, every conversation starts from zero — the agent doesn't know who you are, what you're working on, or what it learned yesterday.

## Solution: Workspace Files

The agent's workspace directory contains structured markdown files that get loaded into the system prompt at startup. The agent can read and update these files during conversations, giving it persistent memory across sessions.

### File Structure

```
workspace/
  AGENTS.md          — Operating instructions (how to behave, what to load)
  SOUL.md            — Personality, values, communication style
  IDENTITY.md        — Name, emoji, what the agent is
  USER.md            — Who the human is, preferences, timezone
  MEMORY.md          — Long-term curated memory (decisions, lessons, context)
  TOOLS.md           — Local tool notes, gotchas, lessons learned
  memory/
    YYYY-MM-DD.md    — Daily raw logs (what happened today)
```

### Loading Order (on startup)

1. Read `AGENTS.md` — this is the bootstrap, tells the agent what else to load
2. Read `SOUL.md` — adopt this personality
3. Read `USER.md` — know who you're talking to
4. Read `MEMORY.md` — recall long-term context
5. Read `memory/YYYY-MM-DD.md` (today + yesterday) — recent context

All of these get injected into the system prompt before the first user message.

### Writing (during conversation)

The agent should update files when:
- It learns something significant → update `MEMORY.md`
- Something notable happens in a session → append to `memory/YYYY-MM-DD.md`
- It discovers a tool quirk or gotcha → update `TOOLS.md`
- The user shares personal info → update `USER.md`
- It wants to change its own personality → update `SOUL.md` (and tell the user)

### Design Principles

1. **Files > "mental notes"** — if it's worth remembering, write it down
2. **MEMORY.md is curated** — not a raw dump, but distilled insights and decisions
3. **Daily files are raw** — append-only logs of what happened
4. **AGENTS.md is the constitution** — rarely changes, sets the rules
5. **Everything is markdown** — human-readable, git-trackable, editable by both human and agent

### Token Budget

Workspace files are injected into the system prompt, so they consume context. Guidelines:
- AGENTS.md: ~2-3K tokens (instructions should be concise)
- SOUL.md: ~500 tokens
- USER.md: ~200 tokens
- MEMORY.md: ~1-2K tokens (curate aggressively)
- Daily files: ~500-1K tokens (only load today + yesterday)
- TOOLS.md: ~500 tokens
- **Total budget: ~5-7K tokens** for workspace context

### Implementation

1. `src/workspace.ts` — loads and caches workspace files
2. Files are read at agent startup and concatenated into the system prompt
3. The agent has write access via its `write_file` and `edit_file` tools
4. Default workspace templates are provided for new users (in `workspace/` dir)

### Differences from OpenClaw

- No HEARTBEAT.md (we don't have a heartbeat system yet)
- No skills directory (tools are built-in for now)
- Simpler — no BOOTSTRAP.md, no group chat rules, just core memory

### Inspired By

This design is directly modeled on OpenClaw's workspace system, which has proven effective in production.
