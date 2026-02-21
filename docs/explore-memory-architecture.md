# Exploration: Memory Architecture & Compaction

Aigent's ability to maintain context over long, complex sessions—without blowing out the LLM context window or racking up massive API bills—relies entirely on its memory system. This document explores patterns for long-term memory, context window management, and state synchronization.

## 1. The Core Challenge: The Context Window

LLMs have finite context windows (e.g., 200k tokens for Claude 3.5 Sonnet). However, long before hitting the hard limit, two things happen:
1.  **Cost:** Every message sent incurs the cost of the entire preceding context. A 100k token context costs ~$0.30 per message (Sonnet). A 50-message conversation at that size costs $15.
2.  **Degradation:** "Lost in the middle" syndrome. The model struggles to reliably retrieve specific facts or tool outputs buried deep in a massive prompt.

Aigent currently employs two strategies to mitigate this: **Prompt Caching** (Anthropic) and **In-Place Compaction** (~70% usage trigger).

## 2. Compaction Strategies (Short-Term Memory)

When the active conversation grows too large, the older messages must be compressed or evicted.

### Strategy A: The Sliding Window (Eviction)
*   **Mechanism:** Keep the system prompt and the last $N$ messages. Drop everything older.
*   **Pros:** Zero LLM cost to execute. Simple to implement.
*   **Cons:** The agent develops "amnesia." If a user defined a rule in message 2, and the conversation is now at message $N+1$, the rule is gone.

### Strategy B: LLM-Driven Summarization (Current Aigent Approach)
*   **Mechanism:** When context hits ~70%, send the first half of the conversation to a cheap model (e.g., Haiku) and ask it to summarize the key facts, decisions, and outcomes. Replace those messages with the summary.
*   **Pros:** Retains critical context while drastically reducing token count.
*   **Cons:** Requires a blocking LLM call during the user's flow. The summary is lossy—subtle nuances or specific code snippets are often discarded. Tool call metadata (which can be bulky) is stripped.

### Strategy C: The Tiered "Scratchpad" (Exploration)
*   **Mechanism:** Instead of summarizing the chat log, the agent is instructed to maintain a `scratchpad` or `context_state` block in its memory. Every time it learns something important or makes a decision, it updates this block. When compaction triggers, old messages are simply dropped (Eviction), but the `scratchpad` survives.
*   **Pros:** The agent explicitly decides what is worth keeping. Less lossy than third-party summarization.
*   **Cons:** Requires the agent to be disciplined about updating the scratchpad constantly.

## 3. Long-Term Memory (The Workspace)

Aigent uses a filesystem-based memory structure (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, and daily logs). This is powerful because it is transparent to the user and easily editable.

### Pattern A: Distillation (The Nightly Build)
*   **Mechanism:** At the end of a session (or via `/reset`), the agent reads the day's raw logs and rewrites `MEMORY.md` to extract enduring knowledge (e.g., "The user prefers Python," "We decided to use PostgreSQL for project X").
*   **Pros:** Keeps the active context clean. `MEMORY.md` becomes a highly dense, high-value asset.
*   **Cons:** Over time, `MEMORY.md` itself becomes too large to fit in the system prompt efficiently.

### Pattern B: Vector Databases / RAG (Retrieval-Augmented Generation)
*   **Mechanism:** Every message, tool output, and file is embedded and stored in a local vector database (e.g., Chroma, SQLite+VSS). When the user asks a question, the system retrieves the top-K most semantically relevant chunks.
*   **Pros:** Scales infinitely. The agent can "remember" a specific bug fix from six months ago without keeping it in the active prompt.
*   **Cons:** Introduces significant complexity (embedding models, database management). RAG is notoriously bad at retrieving structured code or following sequential logic (e.g., "What were the steps we took to fix this?").

### Pattern C: The "Memory Search" Tool (Current Aigent Approach)
*   **Mechanism:** The agent has a `search_memory` tool that performs keyword/regex searches over past session logs.
*   **Pros:** Zero LLM cost to index. Extremely precise for finding specific terms or code snippets. Transparent and debuggable.
*   **Cons:** Requires the agent to proactively realize it needs to search. It relies on the agent guessing the right keywords.

## 4. Optimizing Prompt Caching

Anthropic's Prompt Caching allows developers to mark specific blocks of text (like the system prompt or large documents) to be cached on Anthropic's servers, drastically reducing cost and latency for subsequent turns.

To maximize this, Aigent must structure its payload carefully:

1.  **Static First:** The system instructions (`AGENTS.md`, `SOUL.md`, tool definitions) rarely change during a session. These should be placed at the *very top* of the prompt and marked for caching.
2.  **Dynamic Last:** The active conversation history, which changes on every turn, must be placed *after* the cached blocks.
3.  **The Warm-Up Ping:** When Aigent boots up, it could send a minimal, invisible "ping" request containing the static system prompt to Anthropic. This ensures the cache is warm *before* the user types their first message, guaranteeing a fast first response.

## 5. Summary of Architectural Recommendations

For Aigent's specific "hackable lab" use case, the current filesystem-based approach (Markdown files + `search_memory` tool) is elegant and debuggable. 

To harden it, the focus should remain on **Prompt Caching optimization** (ensuring tool definitions and core instructions are perfectly aligned at the top of the context) and refining the **Compaction prompt** so that LLM-driven summaries preserve critical technical details (like specific file paths or resolved bug IDs) rather than just narrative flow.