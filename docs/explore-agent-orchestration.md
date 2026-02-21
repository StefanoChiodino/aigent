# Exploration: Orchestrating Sub-Agents

Aigent supports non-blocking background tasks via the `dispatch_task` tool and synchronous tasks via `spawn_agent`. This allows the main agent to delegate long-running research, data processing, or builds to a sub-agent while remaining responsive to the user.

This document explores the architectural patterns, concurrency challenges, and communication models required to orchestrate parallel background processes safely.

## 1. The Core Challenge: Concurrency and State

When a single agent operates, the state of the workspace (files, memory) and the conversation history are linear and deterministic.

When you introduce parallel sub-agents, you encounter classic distributed systems problems:
1.  **File Concurrency (Race Conditions):** If Sub-Agent A and Sub-Agent B both try to edit `/workspace/MEMORY.md` at the same time, data will be corrupted or overwritten.
2.  **Context Synchronization:** When a sub-agent finishes a 5-minute task, how does its finding get injected back into the main agent's context without confusing the LLM about the timeline of events that occurred in the meantime?
3.  **Context Bloat:** If a sub-agent reads a 10,000-line log file and returns it directly to the main agent, it will instantly blow out the main agent's context window.
4.  **Resource Exhaustion:** If the main agent recursively spawns sub-agents in a loop, it will quickly exhaust API rate limits or host memory (a "fork bomb").

## 2. Orchestration & Concurrency Patterns

### Pattern A: Fire and Forget (Current Aigent Approach)
*   **Mechanism:** The main agent calls `dispatch_task(instruction)`. The system spawns an independent Node.js sandbox process with a read-only environment. When it finishes, the system appends a system message to the main agent's chat history: `[Task Completed] Result: ...`.
*   **Pros:** Very simple to implement. Highly secure (sub-agents are read-only, so no race conditions on files).
*   **Cons:** The sub-agent cannot write code, fix bugs, or save files. It can only read and return text. If the result string is massive, it bloats the main agent's context window.

### Pattern B: The Shared Workspace with Mutex Locks
*   **Mechanism:** Sub-agents are granted write access to `/workspace`. However, all file operations (`write_file`, `patch`) must acquire a mutex lock on the specific file via the Gatekeeper. If a file is locked, the tool call fails, forcing the LLM to retry or wait.
*   **Pros:** Allows parallel agents to actively build and modify the project together.
*   **Cons:** Extremely difficult to enforce at the LLM level. LLMs do not handle "wait for lock" loops gracefully and will likely hallucinate, assume the file doesn't exist, or fail the task entirely.

### Pattern C: The "Git Branch" Model (Exploration)
*   **Mechanism:** When `dispatch_task` is called, the Gatekeeper copies the current `/workspace` into an isolated, temporary directory (a "branch"). The sub-agent works entirely in this isolated environment with full read/write access. When it finishes, it uses a `propose_merge` tool to submit its changes as a unified diff back to the main agent.
*   **Pros:** Eliminates race conditions entirely. The main agent reviews the diff and applies it, maintaining total control over the canonical workspace.
*   **Cons:** High disk I/O overhead. Requires the main agent to be capable of resolving merge conflicts if it also modified those files while the sub-agent was running.

## 3. Communication Models

How should the main agent and sub-agents pass data?

### 1. Hierarchical (Hub and Spoke)
The main agent is the Hub. Sub-agents cannot talk to each other; they only return data to the Hub when they finish. (This is the current Aigent model and the easiest to manage).

### 2. Peer-to-Peer
Agents can discover each other and send messages continuously. (Fascinating for research, but usually leads to infinite loops of agents politely agreeing with each other or getting stuck in "No, you do it" loops).

### 3. The Blackboard Pattern (Recommended for Aigent)
Instead of returning massive text strings directly into the main agent's chat history, sub-agents write their findings to a shared temporary file (e.g., `/tmp/blackboard/task_xyz.md`).
*   **How it works:** When the sub-agent finishes, the Gatekeeper injects a tiny message into the main agent's context: `[Task xyz Completed] Result saved to /tmp/blackboard/task_xyz.md`.
*   **Why it's better:** The main agent can decide *when* and *if* it wants to read that file using the `read_file` tool. This keeps the main chat history completely clean and prevents sudden token bloat.

## 4. Sub-Agent Capability Scoping

By default, a background agent should **not** have the same tools as the main agent.

*   **Read-Only Default:** As implemented in Aigent, background tasks default to `exec_readonly` and `fetch_readonly`. This is the safest default until Pattern C (Git Branching) is implemented.
*   **No Host Interaction:** A background agent should *never* have access to the `host` tool, `request_mount`, or `request_config_write`. It cannot prompt the user with modals, as the user is busy talking to the main agent.
*   **Model Downgrading:** The `dispatch_task` tool should force the sub-agent to use a cheaper, faster model (e.g., Haiku or GPT-4o-mini) by default, unless the main agent explicitly passes a flag requesting a reasoning model.

## 5. Architectural Recommendations for Aigent

To harden and scale Aigent's sub-agent capabilities, the following architectural steps are recommended:

1.  **Enforce the Blackboard Pattern:** Modify `dispatch_task` and `spawn_agent` so that any result larger than ~500 tokens is automatically written to a file in `/tmp/blackboard/`, returning only the filepath to the main agent.
2.  **Concurrency Caps:** The Gatekeeper must enforce a hard limit on concurrent `dispatch_task` executions (e.g., `MAX_SUB_AGENTS=3`). If the main agent tries to spawn a 4th, the tool call should return an error: `Resource busy, wait for a task to complete.`
3.  **Strict Capability Pruning:** Ensure the tool registry explicitly hides interactive tools (`request_mount`, `request_config_write`, `host`) from the sub-agent's payload. Sub-agents must operate autonomously without expecting user input.