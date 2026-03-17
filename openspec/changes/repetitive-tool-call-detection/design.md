## Context

After raising `MAX_AGENT_ITERATIONS` from 25 to 200, the agent can now run long agentic tasks without hitting the limit prematurely. However, this also means a stuck agent can burn hundreds of tool calls before the user notices. The existing error-rate detector (`src/agent.ts:1063`) catches high *failure* rates but not high *repetition* rates — a `grep` loop succeeds every time.

The agent loop in `agent.ts` already tracks `toolExecutionHistory`. The fix is to add a sliding-window repetition check immediately after tool results are collected, before the next LLM call.

## Goals / Non-Goals

**Goals:**
- Detect when the same tool + arguments appear ≥ N times within the last W tool calls
- Inject a clear error message into the conversation and halt the current turn when a loop is detected
- Make thresholds configurable via env vars with safe defaults
- Cover detection with unit tests and the turn-halt behavior with an integration test

**Non-Goals:**
- Semantic/fuzzy deduplication (exact arg match is sufficient and cheap)
- Detecting loops that span multiple user turns
- UI changes or new gatekeeper logic
- Detecting loops involving *different* tools that still make no progress (out of scope for v1)

## Decisions

### 1. Where to insert the check

**Decision**: After all tool results are collected in the `while` loop (after the `await Promise.all(toolPromises)` block), before pushing tool results and looping back.

**Why**: This is the one point where all tool calls for an iteration are known. Checking here means we interrupt immediately after detecting the loop rather than one iteration later.

**Alternative considered**: Check inside each tool execution. Rejected — parallel tool execution makes this racy and the check doesn't belong in tool logic.

### 2. Detection key

**Decision**: Key = `tool_name + ":" + stable_json(args)` where stable JSON uses sorted keys via `JSON.stringify` with a replacer that sorts object keys.

**Why**: Simple, zero-dependency, exact match. A grep with different patterns is correctly treated as a different call.

**Alternative considered**: Hashing the key string. Unnecessary for window sizes ≤ 20.

### 3. Window and threshold

**Decision**: Sliding window of the last `W` tool calls (default `W=10`), trigger when any key appears ≥ `N` times (default `N=5`). Configurable via `AIGENT_LOOP_WINDOW` and `AIGENT_LOOP_MAX_REPEATS`.

**Why**: Window=10, repeats=5 means the loop occupies ≥50% of recent calls — clearly stuck. Low enough to catch tight loops (5 identical calls in a row) while not triggering on legitimate repeated use of a cheap tool.

### 4. Response when loop detected

**Decision**: Push a synthetic tool result error for the offending tool call, then throw a descriptive `LoopDetectedError` that is caught by the turn handler and returned as a user-visible message. The message names the tool and suggests the agent is stuck.

**Alternative considered**: Inject a user message and let the agent continue. Rejected — the agent just proved it's stuck; giving it another LLM call wastes tokens. Halting is safer; the user can re-prompt.

### 5. Tracker state lifetime

**Decision**: The `ToolLoopDetector` instance is created per-turn (not per-session). A fresh turn resets the window.

**Why**: Legitimate repeated tool use across turns is fine. The problem is only within a single agentic turn.

## Risks / Trade-offs

- **False positives on legitimately repeated calls** (e.g., `read_file` on a config repeatedly during scaffolding). Mitigation: default threshold of 5 is high enough that 1–2 repetitions are fine; most real loops will hit 10+.
- **Exact-match only** — a loop with slightly varying args won't be caught. Accepted for v1; fuzzy matching adds complexity with unclear benefit.
- **Parallel tool execution** — multiple tool calls per iteration all land in the same window. This is correct behavior: if the agent fans out 5 identical greps in one iteration, that's also a bug.

## Migration Plan

1. Add `ToolLoopDetector` class to `src/agent.ts` (or a small new file `src/loop-detector.ts`)
2. Instantiate per-turn in `Agent.chat()`
3. Call `detector.check(toolCalls)` after collecting results; throw on detection
4. Read env vars for thresholds; document in README env var table
5. Write unit tests for `ToolLoopDetector` and integration test for turn-halt behavior
6. Run `make check` — all must pass
