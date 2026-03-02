# Design: Token Optimization

> How aigent minimizes context window consumption — keeping the agent effective
> longer without losing access to the information it needs.

## The Problem

aigent's 200K context window fills up fast. Verbose tool outputs (build logs, git
diffs, fetch responses), uncompressed screenshots, and 26 tool definitions sent
on every API call all compete for space. Once the window fills, compaction kicks
in and older context is lost. The agent becomes less effective, and costs increase
because each API call carries more tokens.

The core insight: **the main agent only needs summaries; cheap sub-agents can
analyze full outputs on demand without polluting the main context window.**

---

## Research

### Context Mode (MCP Server)

[mksg.lu/blog/context-mode](https://mksg.lu/blog/context-mode) |
[HN discussion](https://news.ycombinator.com/item?id=47193064)

Context Mode is an MCP server that intercepts tool outputs and compresses them
before they enter the context window. Key techniques:

1. **Sandbox execution** — isolated subprocesses for code execution; only stdout
   enters context. Raw data (log files, API responses) stays in the sandbox.
2. **SQLite FTS5 knowledge base** — BM25 ranking, Porter stemming, markdown
   chunking by headings with code block preservation. Returns indexed content,
   not summaries.
3. **PreToolUse hook routing** — channels all built-in tool outputs through
   compression automatically.

Measured compression ratios:

| Input | Before | After | Reduction |
|-------|--------|-------|-----------|
| Playwright snapshots | 56 KB | 299 B | 99.5% |
| GitHub issues (20) | 59 KB | 1.1 KB | 98.1% |
| Access logs (500 req) | 45 KB | 155 B | 99.7% |
| CSV data (500 rows) | 85 KB | 222 B | 99.7% |
| **Full session** | **315 KB** | **5.4 KB** | **98%** |

Session time extended from ~30 minutes to ~3 hours.

**Architectural limitation:** Cannot intercept MCP tool responses (JSON-RPC flows
directly to model). Only applies to built-in tools in subprocesses.

### Community Techniques (HN)

- **Hybrid retrieval** — Model2Vec embeddings + sqlite-vec + FTS5 with
  Reciprocal Rank Fusion. 15,800-file vault compressed to 83MB index.
- **RTK** (github.com/rtk-ai/rtk) — CLI output trimming for common tools.
- **Guardrails** (github.com/Giancarlos/guardrails) — Token-optimized CLI output.
- **Dynamic context pruning** — removing failed debugging attempts after resolution.
- **Dataframe summaries** — token-optimized views with drill-down hints.
- **Context as git branches** — cherry-picking conversation context.

**Key trade-off:** Aggressive compression can lose critical info. "Compressing 153
git commits to 107 bytes means the LLM has to write the perfect extraction script
before it can see the data." Must preserve the ability to retrieve full content.

### OCR Options Evaluated

| Tool | Type | Speed | Install | Dep overhead |
|------|------|-------|---------|-------------|
| **tesseract CLI** | System binary | ~200-500ms | `apt install tesseract-ocr` | Zero npm deps |
| tesseract.js | npm (WASM) | ~1-3s | npm install | ~19MB WASM + lang data |
| @xenova/transformers TrOCR | npm (ML model) | ~2-5s | Already installed | Heavy model download |
| PaddleOCR | Python | ~500ms | pip install | Python dependency |

Recommendation: **tesseract CLI** — follows the external-tool pattern (like STT/TTS),
fastest option, zero npm overhead, degrades gracefully when not installed.

---

## Existing Mechanisms

| Mechanism | Location | Status | Notes |
|-----------|----------|--------|-------|
| Context compaction | `compact.ts` | Always on at 80% | Haiku summary, strips images, 600-char tool output |
| Tool result summarization | `agent.ts:717-778` | **Disabled by default** | Full pipeline: Haiku summary, temp file, retrieval path |
| Dynamic truncation | `agent.ts:787-802` | Always on | Budget-aware, floor 10K chars, head-only |
| Image deduplication | `agent.ts:646-657` | Always on | SHA256 first 2KB |
| Prompt caching | `agent.ts:130`, `provider.ts:131` | Always on | 2-part system prompt, last tool cached |
| Workspace mtime cache | `workspace.ts:31-43` | Always on | Skip unchanged files |
| Daily log indexing | `workspace.ts:150-160` | Always on | Index only, read on demand |
| Adaptive thinking | `agent.ts:610-640` | Always on | Auto-lower for short messages |
| Memory distillation | `compact.ts:234-283` | On reset/end | Haiku merges into MEMORY.md |

Processing pipeline (`agent.ts:349-356`):
```
String:  tool output → maybeSummarizeToolResult() → getToolOutputMaxChars() → truncate → push
Images:  tool output → deduplicateImages() → push (no compression, no OCR)
```

---

## Implementation

### Phase 1 — Enable & improve existing mechanisms

**1a. Enable tool result summarization by default**

The pipeline exists — just flip defaults. Use blocklist mode so tools that return
content the agent needs verbatim (`read_file`, `grep`, `glob`, `list_files`,
`edit_file`, `write_file`, `patch`) are excluded. Everything else (`exec`, `fetch`,
`browser_ext`, `tree`, `search_memory`, `search_episodes`, etc.) gets summarized
by Haiku when over 300 tokens. Full output persists to
`/tmp/aigent/tool-results/{id}.txt`.

**1b. Head+tail truncation**

Replace head-only truncation with 70% head + 20% tail + middle marker. Error
messages and final results live at the tail of command output.

**1c. Full output persistence on truncation**

Even when summarization is disabled/fails, write the full output to temp file
and append the path. Ensures the sub-agent retrieval pattern always works.

**1d. Image compression**

Add `sharp` dependency. Downscale to max 1568px (Anthropic's max useful
resolution), convert non-alpha PNGs to JPEG quality 80. Skip images already
small. Wire into `readImageBase64()`, `deduplicateImages()`, and user upload
handling.

**1e. OCR text extraction**

Use system-installed `tesseract` CLI. OCR-first strategy: extract text, include
as primary content, save compressed image to disk with retrieval path. Only
include image inline for explicit visual/layout questions. Degrades gracefully
when tesseract not installed.

### Phase 2 — Sub-agent retrieval pattern

Add system prompt guidance: when a tool result is summarized, spawn a cheap
sub-agent (Haiku) to analyze the full output instead of pulling it into main
context with `read_file`. Update summary format to explicitly guide this pattern.

### Phase 3 — Tool definition optimization

**3a. Trim descriptions** — move verbose tool docs to the cached system prompt.
Biggest offenders: `browser_ext` (~500 tokens), `dispatch_task` (~300),
`spawn_agent` (~250). Target: ~60-80 tokens per tool description.

**3b. Dynamic tool filtering** — only send tools whose prerequisites are met.
Browser tools when extension/Playwright available, host tools when daemon
connected. Conservative: filter by capability availability, not conversation content.

### Rejected approaches

- **Structured output parsers** — low impact, risks losing details.
- **Dynamic context pruning** — high complexity, compaction handles it.
- **SQLite FTS5 for tool outputs** — over-engineering for current scale;
  episode semantic search already exists.
