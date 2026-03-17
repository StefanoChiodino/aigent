## Why

After raising agent iteration limits from 25 to 200, the agent can now get stuck in repetitive loops — calling the same tool with identical (or near-identical) arguments dozens of times in a row without making progress. There is no anomaly detection to catch and interrupt this behavior before it wastes tokens and budget.

## What Changes

- Introduce a **repetitive tool call detector** in the agent loop that tracks recent tool calls and detects loops
- When a loop is detected, the agent loop halts with a clear error injected into the conversation, prompting the agent to reflect and try a different approach
- Configurable thresholds: window size (how many recent calls to inspect) and max repetitions before triggering
- Detection runs in the agent core (`agent.ts`) — no gatekeeper changes needed
- Add unit tests covering detection logic and integration tests covering loop interruption

## Capabilities

### New Capabilities

- `repetitive-tool-call-detection`: Detects when the agent calls the same tool with identical arguments repeatedly within a sliding window, and interrupts the loop with a descriptive error

### Modified Capabilities

- `core`: The agent conversation loop gains loop-detection logic; the agent may now receive an injected system message mid-loop when anomalous behavior is detected

## Impact

- `src/agent.ts` — primary change site; sliding-window tracker added to the main turn loop
- `src/server.ts` — may surface new error type to the web bridge
- Configuration: thresholds exposed as env vars (`AIGENT_LOOP_WINDOW`, `AIGENT_LOOP_MAX_REPEATS`) with sensible defaults (window: 10, max repeats: 5)
- No breaking API changes; behavior is additive
