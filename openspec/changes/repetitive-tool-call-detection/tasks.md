## 1. Core Detection Logic

- [x] 1.1 Create `ToolLoopDetector` class (in `src/agent.ts` or `src/loop-detector.ts`) with sliding-window tracking, configurable via `AIGENT_LOOP_WINDOW` and `AIGENT_LOOP_MAX_REPEATS` env vars, defaulting to window=10, max-repeats=5
- [x] 1.2 Implement stable JSON key generation for (tool_name, args) deduplication (sort object keys before stringifying)
- [x] 1.3 Implement `check(toolCalls)` method that throws `LoopDetectedError` naming the offending tool when threshold is exceeded

## 2. Agent Loop Integration

- [x] 2.1 Instantiate a fresh `ToolLoopDetector` at the start of each `Agent.chat()` call (per-turn reset)
- [x] 2.2 Call `detector.check(response.toolCalls)` after collecting all tool results in the agent `while` loop, before looping back
- [x] 2.3 Catch `LoopDetectedError` in the turn handler and return it as a user-visible error message (same pattern as the existing error-rate detector)

## 3. Unit Tests

- [x] 3.1 Write failing unit test: detector triggers when same tool+args called ≥ N times within window
- [x] 3.2 Write failing unit test: detector does NOT trigger when repetitions are below threshold
- [x] 3.3 Write failing unit test: detector does NOT trigger when same tool is called with different args
- [x] 3.4 Write failing unit test: detector resets correctly between instantiations (turn isolation)
- [x] 3.5 Write failing unit test: custom thresholds via env vars are respected
- [x] 3.6 Run tests — confirm they fail before implementation
- [x] 3.7 Implement logic to make tests pass; run tests again to confirm green

## 4. Integration / E2E Tests

- [x] 4.1 Write integration test that mocks a tool to return success repeatedly and verifies the agent turn halts with a loop-detection error after threshold is exceeded
- [x] 4.2 Confirm test fails before integration, passes after

## 5. Documentation & Cleanup

- [x] 5.1 Add `AIGENT_LOOP_WINDOW` and `AIGENT_LOOP_MAX_REPEATS` to the env vars table in `README.md`
- [x] 5.2 Run `make check` — typecheck, unit tests, web build all pass
- [x] 5.3 Commit
