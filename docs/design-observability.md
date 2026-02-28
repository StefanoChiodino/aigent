# Design: Observability and Tracing

## Status: Implemented

All three observability features are implemented and tested.

## 1. Request Correlation ID (`reqId`)

A 6-character hex ID is generated per user message and threaded through every layer for end-to-end log correlation.

### Flow

1. **Browser UI** (`web/src/components/InputArea.tsx`):
   - Generates `reqId` via `Math.random().toString(16).slice(2, 8)` on each message submit
   - Included in WebSocket payload: `{ type: 'message', content: '...', reqId: 'f9d8e7' }`

2. **Web bridge** (`src/web-bridge.ts`):
   - Forwards `reqId` to the agent server via Unix socket NDJSON

3. **Agent server** (`src/server.ts`):
   - Stores `reqId` in `QueuedMessage` interface
   - Wraps `processMessage()` in `reqContext.run({ reqId }, ...)` using `AsyncLocalStorage`
   - All downstream async code automatically inherits the reqId

4. **Logger** (`src/logger.ts`):
   - Reads `getReqId()` from `AsyncLocalStorage` on every log line
   - Prepends `[reqId]` when present: `2024-01-15T10:30:45.123Z [INFO] [server] [f9d8e7] Listening`

5. **Audit log** (`src/audit.ts`):
   - Auto-reads `reqId` from `AsyncLocalStorage` (or accepts explicit override)
   - Includes `"reqId":"f9d8e7"` in NDJSON entries

6. **Background tasks** (`src/server.ts` `dispatchBackgroundTask()`):
   - Captures parent reqId before the async IIFE
   - Creates derived reqId: `${parentReqId}.${taskId.slice(0,4)}`
   - Wraps task body in `reqContext.run()` with derived ID

7. **MCP servers** (`src/mcp.ts`):
   - Includes `reqId` in JSON-RPC `_meta` parameter for cross-process tracing

### Key module

`src/req-context.ts` — exports `reqContext` (AsyncLocalStorage instance) and `getReqId()` helper. Zero overhead when no store is active.

## 2. Log Rotation

Simple size-based rotation at process startup. No runtime rotation, no dependencies.

### Module

`src/log-rotate.ts` — `rotateIfNeeded(path, maxBytes = 5MB, keep = 2)`

- Checks file size with `statSync`
- Cascades rotations: delete `.2`, rename `.1` → `.2`, rename current → `.1`
- Fire-and-forget: all errors silently swallowed

### Integration

- **Gatekeeper** (`src/gatekeeper.tsx`): calls `rotateIfNeeded(LOG_PATH)` before `createWriteStream`
- **Audit log** (`src/audit.ts`): calls `rotateIfNeeded(auditLogPath)` at module load

## 3. Tool Call Audit Trail

Tool call events are persisted to the daily session log (`workspace/memory/YYYY-MM-DD.md`) so they survive context compaction.

### Module

`src/tool-log.ts` — `appendToolLog(memoryDir, info, reqId?)` and `formatToolLogLine(info, reqId?)`

### Format

Pipe-delimited markdown table rows:

```markdown
## Tool Calls

| Time | Tool | Input | Duration | Status | Req |
|------|------|-------|----------|--------|-----|
| 14:23:05 | exec | {"command":"git status"} | 120ms | ok | f9d8e7 |
| 14:23:08 | read_file | {"path":"/src/agent.ts","offset":1,"limit":50} | 3ms | ok | f9d8e7 |
```

### Integration

- `src/agent.ts`: `ChatCallbacks.onToolComplete` fires after each tool execution (success or failure)
- `src/server.ts`: wires `onToolComplete` to `appendToolLog()` in `processAgentTurn()` callbacks

## Files

| File | Purpose |
|------|---------|
| `src/req-context.ts` | AsyncLocalStorage for reqId propagation |
| `src/log-rotate.ts` | Startup log rotation utility |
| `src/tool-log.ts` | Tool call daily log writer |
| `src/logger.ts` | Structured logger (reads reqId from context) |
| `src/audit.ts` | Security audit log (includes reqId, startup rotation) |
| `src/req-context.test.ts` | Tests for req context |
| `src/log-rotate.test.ts` | Tests for log rotation |
| `src/tool-log.test.ts` | Tests for tool call formatting and writing |
