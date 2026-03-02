# Memory Architecture

> Design document for aigent's memory system. Captures the thinking behind current
> decisions and the roadmap toward a cost-efficient, human-inspired memory model.

---

## The Problem

LLM agents are stateless between sessions. Everything the agent "knows" must be
injected into the context window at the start of each conversation. This creates
a direct tension:

- **More memory = better continuity** — the agent knows what was decided, what was
  built, what the user prefers
- **More memory = more tokens = more cost** — every token in the system prompt is
  paid for on every API call

The naive solution (dump everything into the prompt) breaks down quickly. In this
project, 3 days of session logs reached ~40,000 tokens (~$0.60 per session start
on a capable model), with most of it being tool call outputs and repetitive entries.

---

## Human Memory as a Model

Human memory is a useful engineering analogy — not because AI is biological, but
because humans evolved a cost-efficient solution to the same problem: how do you
maintain continuity across time without carrying everything around?

| Human memory type | aigent equivalent | Cost |
|---|---|---|
| Working memory (~7 items) | Active context window | Paid per token |
| Short-term / episodic | MEMORY.md (curated, recent) | Paid per token (small) |
| Long-term / semantic | Daily logs (archived, searchable) | Free until retrieved |
| Procedural (how-to) | Model weights | Fixed (already paid) |
| Sleep consolidation | distillToMemory() on reset/shutdown | One-time LLM call |
| Cued recall | search_memory tool (future) | On-demand retrieval cost |

The key human insight: **you don't carry all your memories — you retrieve relevant
ones when cued.** The brain doesn't load yesterday's breakfast into working memory
unless something triggers that memory.

---

## Current Architecture (as of 2026-02-20)

### Layers

```
System prompt (always loaded, paid every turn)
├── Config files: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md  (~2.5KB)
└── MEMORY.md — curated long-term memory, model-maintained              (~1–4KB)
    + Session log index (dates + file sizes only, not content)          (~0.2KB)

Daily logs: workspace/memory/YYYY-MM-DD.md  (NOT in prompt by default)
└── Compaction summaries appended during session
└── "Memory distilled" marker on reset/shutdown
└── Agent can read any log file on demand via read_file tool
```

### Env flags

| Flag | Effect |
|---|---|
| *(default)* | MEMORY.md + config files + log index in prompt |
| `AIGENT_SLIM_PROMPT=1` | Skip MEMORY.md (for very small context windows) |
| `AIGENT_FULL_LOGS=1` | Include last 3 days of logs in full (old behaviour) |

### Consolidation (the "sleep" step)

**Mid-task compaction** (`compactConversation`): triggered automatically at 60–70%
context usage. Summarises old messages into a compact task-focused reference,
replaces them in the message list. Keeps the agent on track. Does NOT touch
MEMORY.md — it's not the right moment for long-term consolidation.

**End-of-session / reset** (`distillToMemory`): when the user resets or the agent
shuts down, the full conversation is sent to the model with the existing MEMORY.md
and a prompt to merge what's worth keeping. MEMORY.md is rewritten (not appended).
Daily log gets a minimal timestamp marker.

---

## Cost Analysis

Approximate costs (varies by provider and model):

| Scenario | Tokens | Cost per session |
|---|---|---|
| Old: 3 days of logs in prompt | ~40,000 | ~$0.60 startup cost |
| Current: MEMORY.md + index | ~4,000 | ~$0.06 startup cost |
| distillToMemory() call (on reset) | ~5,000 in + ~1,000 out | ~$0.15 one-time |
| Keyword memory search (future) | 0 LLM tokens | Free |
| Flash-filtered memory retrieval (future) | ~5,000 in + ~300 out | ~$0.005/query |

**Key insight:** Output tokens are ~5× more expensive than input tokens on Anthropic.
This means:
- Loading memory into the prompt (input) is relatively cheap
- Generating summaries (output) is expensive — use sparingly
- Retrieval without LLM filtering (grep/keyword) is free

---

## Roadmap

### Phase 1 — Done ✓
- MEMORY.md as curated short-term memory in system prompt
- Daily logs as archive (index only in prompt, full content on demand)
- `distillToMemory()` on reset and session shutdown
- Mid-task `compactConversation` stays task-focused, doesn't pollute long-term memory

### Phase 2 — Keyword search (next)
Add a `search_memory` tool that greps across daily logs for a query term.
Zero LLM cost — pure file I/O. The agent calls this when the user asks
"what did we decide about X?" or when it needs context from past sessions.

Implementation:
- Tool: `search_memory(query: string, days?: number) → string`
- Searches log files with regex/grep, returns matching sections with dates
- No embeddings, no vector store, no infrastructure — just file reads
- Good enough for most queries when logs have natural-language headings

### Phase 3 — Flash-filtered retrieval (when logs get large)
When keyword search returns too much noise (e.g. 6 months of logs), add a
filter step: send matching sections to a flash-tier model to extract only
what's relevant to the query. Returns a 200-token digest.

Cost at scale: negligible at flash-tier pricing.

Implementation:
- `search_memory` tool calls the flash model internally when result set > threshold
- Uses the project's existing provider abstraction, forces `flash` tier
- Result injected into context as a retrieved memory block

### Phase 4 — RAG with embeddings (if/when needed)
Full vector embedding search over log chunks. Only worth the infrastructure
complexity if:
- Logs span 6+ months (keyword search becomes too noisy)
- Queries require semantic similarity (not just keyword matching)
- The agent needs to proactively surface memories without explicit user cues

Options to evaluate at that point:
- Local embeddings (no cost, no latency): `nomic-embed-text` via Ollama
- Anthropic voyage embeddings: $0.02/M tokens (tiny)
- Store: SQLite with sqlite-vec extension (zero infrastructure)

Not worth building now — keyword search + flash filtering will cover the
next 12+ months of use.

---

## Design Principles

1. **Pay only for what's needed in the current session.** Don't pre-load
   everything — retrieve on demand.

2. **Consolidate at natural boundaries.** Reset and shutdown are the "sleep"
   moments. Mid-task compaction is not.

3. **Prefer input tokens over output tokens.** Reading is 5× cheaper than
   generating. When in doubt, retrieve more context rather than generating
   a summary.

4. **Use cheap models for retrieval, expensive models for reasoning.**
   Flash-tier for scanning/filtering logs. Ultra-tier for the actual conversation.
   The agent already supports model switching mid-task via `switch_model`.

5. **MEMORY.md is the single source of truth for persistent knowledge.**
   It should always be accurate and concise. The model maintains it, not
   the engineer. Daily logs are the raw archive — MEMORY.md is the digest.
