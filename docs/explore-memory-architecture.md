# Exploration: Memory Architecture & Compaction

Aigent's ability to maintain context over long, complex sessions—without blowing out the LLM context window or racking up massive API bills—relies entirely on its memory system. This document explores patterns for long-term memory, context window management, and state synchronization.

## 1. The Core Challenge: The Context Window

LLMs have finite context windows (e.g., 200k tokens for Claude 3.5 Sonnet). However, long before hitting the hard limit, two things happen:
1.  **Cost:** Every message sent incurs the cost of the entire preceding context. A 100k token context costs ~$0.30 per message (Sonnet). A 50-message conversation at that size costs $15.
2.  **Degradation:** "Lost in the middle" syndrome. The model struggles to reliably retrieve specific facts or tool outputs buried deep in a massive prompt.

Aigent currently employs two strategies to mitigate this: **Prompt Caching** (Anthropic) and **In-Place Compaction** (~70% usage trigger).

## 2. Deep Dive: Optimizing Prompt Caching

Anthropic's Prompt Caching allows developers to mark specific blocks of text (like the system prompt or large documents) to be cached on Anthropic's servers. Cached tokens cost 10x less and resolve significantly faster.

To maximize this, the payload structure must be deterministic and ordered from "most static" to "most dynamic."

### The Ideal Payload Structure
1.  **Block 1: Immutable Core (Cache Breakpoint 1)**
    *   Base Agent Instructions (`AGENTS.md`, `SOUL.md`)
    *   Tool Definitions (JSON Schemas)
    *   *This block almost never changes. Caching it saves ~3k-5k tokens per request.*
2.  **Block 2: Session Context (Cache Breakpoint 2)**
    *   The User Profile (`USER.md`)
    *   The Long-Term Memory (`MEMORY.md`)
    *   *This block changes infrequently (usually only after a session reset or explicit edit).*
3.  **Block 3: The Active Conversation (Uncached)**
    *   The array of User and Assistant messages.
    *   *This changes on every single turn and cannot be effectively cached across sequential turns.*

### The Warm-Up Pattern
When Aigent boots up, the Anthropic cache for Block 1 & 2 is cold. The first user request will incur full latency and cost.
*   **Pattern:** On startup, the Gatekeeper fires a background, asynchronous "ping" request to Anthropic containing only Block 1 & 2 and a system prompt saying "Acknowledge receipt." By the time the user types their first message, the cache is warm, ensuring a sub-second response time.

## 3. Deep Dive: Context Compaction Strategies

When the active conversation (Block 3) grows too large (e.g., >70% of the available window), the older messages must be compressed or evicted.

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

### Refining the Summarization Prompt (Actionable Fix)
If sticking with Strategy B, the prompt given to the cheap summarization model (Haiku) must be strictly engineered. Currently, summarizations tend to be narrative ("The user asked to fix a bug. The agent ran a script. The bug was fixed."). 
*   **The Fix:** Force structured output.
    ```text
    Summarize this conversation segment. You MUST retain:
    1. Exact file paths referenced.
    2. Specific error codes or terminal outputs discussed.
    3. Unresolved user requests.
    DO NOT write a narrative. Use bullet points.
    ```

## 4. Long-Term Memory (The Workspace)

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

## 5. Summary of Architectural Recommendations

For Aigent's specific "hackable lab" use case, the current filesystem-based approach (Markdown files + `search_memory` tool) is elegant and debuggable. 

To harden it, the focus should be:
1.  **Implement the Cache Warm-Up Ping** on Gatekeeper startup.
2.  **Refine the Compaction Prompt** to enforce structured, technical bullet points rather than narrative summaries.
3.  **Ensure strict Payload Ordering** (Tools -> System -> Memory -> Chat) to maximize cache hit rates across turns.