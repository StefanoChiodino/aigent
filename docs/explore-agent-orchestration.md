# Exploration: Orchestrating Sub-Agents

Aigent supports non-blocking background tasks via the `dispatch_task` tool. This allows the main agent to delegate long-running research or data processing to a sub-agent while remaining responsive to the user. 

This document explores the architectural patterns, challenges, and solutions for orchestrating these parallel background processes.

## 1. The Core Challenge: Concurrency and State

When a single agent operates, the state of the workspace (files, memory) and the conversation history are linear and deterministic. 

When you introduce parallel sub-agents, you encounter classic distributed systems problems:
1.  **File Concurrency (Race Conditions):** If Sub-Agent A and Sub-Agent B both try to edit `/workspace/MEMORY.md` at the same time, data will be corrupted or overwritten.
2.  **Context Synchronization:** When a sub-agent finishes, how does its finding get injected back into the main agent's context without confusing the LLM about the timeline of events?
3.  **Resource Exhaustion:** If the main agent recursively spawns sub-agents in a loop, it will quickly exhaust API rate limits or host memory.

## 2. Orchestration Patterns

### Pattern A: Fire and Forget (Current Aigent Approach)
*   **Mechanism:** The main agent calls `dispatch_task(instruction)`. The system spawns an independent Node.js sandbox process with a read-only environment. When it finishes, the system appends a system message to the main agent's chat history: `[Task Completed] Result: ...`.
*   **Pros:** Very simple to implement. Highly secure (sub-agents are read-only).
*   **Cons:** The sub-agent cannot write code, fix bugs, or save files. It can only read and return text. If the result is massive, it bloats the main agent's context window.

### Pattern B: The Shared Workspace with Locking
*   **Mechanism:** Sub-agents are granted write access to `/workspace`. However, all file operations (`write_file`, `patch`) must acquire a mutex lock on the specific file. If a file is locked, the tool call fails, forcing the LLM to retry or wait.
*   **Pros:** Allows parallel agents to actively build and modify the project.
*   **Cons:** Extremely difficult to enforce at the LLM level. LLMs do not handle "wait for lock" loops gracefully and will likely hallucinate or fail the task.

### Pattern C: The "Git Branch" Model (Exploration)
*   **Mechanism:** When `dispatch_task` is called, the system copies the current `/workspace` into an isolated, temporary directory (a "branch"). The sub-agent works entirely in this isolated environment. When it finishes, it uses a `propose_merge` tool to submit its changes as a unified diff back to the main agent.
*   **Pros:** Eliminates race conditions entirely. The main agent reviews the diff and applies it, maintaining total control over the canonical workspace.
*   **Cons:** High disk I/O overhead. Requires the main agent to be capable of resolving merge conflicts if it also modified those files while the sub-agent was running.

## 3. Communication Patterns

How should agents talk to each other?

1.  **Hierarchical (Hub and Spoke):** The main agent is the Hub. Sub-agents cannot talk to each other; they only return data to the Hub. (This is the easiest to manage and debug).
2.  **Peer-to-Peer:** Agents can discover each other and send messages. (Fascinating for research, but usually leads to infinite loops of agents politely agreeing with each other).
3.  **The Blackboard:** Instead of returning massive text strings, sub-agents write their findings to a shared file (e.g., `/workspace/BLACKBOARD.md`). The main agent is notified when the blackboard is updated and can read it at its leisure. This keeps the main chat history clean.

## 4. Sub-Agent Capability Scoping

By default, a background agent should not have the same tools as the main agent.

*   **Read-Only Default:** As implemented in Aigent, background tasks default to `exec_readonly` and `fetch_readonly`.
*   **No Host Interaction:** A background agent should *never* have access to the `host` tool, `request_mount`, or `request_config_write`. It cannot prompt the user with modals, as the user is busy talking to the main agent.
*   **Model Downgrading:** The `dispatch_task` tool should force the sub-agent to use a cheaper, faster model (e.g., Haiku or GPT-4o-mini) unless the main agent explicitly requests a reasoning model.

## 5. Summary of Architectural Recommendations

For Aigent, the most robust path forward is enhancing the **Hierarchical / Blackboard model**:
1.  Keep sub-agents read-only by default to avoid file corruption.
2.  Implement the **Blackboard pattern**: Modify `dispatch_task` so that if the result is larger than ~500 tokens, the Gatekeeper automatically writes the result to a temp file (`/tmp/task_result_xyz.txt`) and injects a short message into the main chat: `[Task Completed] Result is large. Read /tmp/task_result_xyz.txt`. This protects the main agent's context window.
3.  Implement a hard cap on concurrent sub-agents (e.g., max 3) to prevent fork bombs.