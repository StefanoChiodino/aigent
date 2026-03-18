## Why

When debugging or learning how the agent works, there is no way to see the raw LLM API response — the actual content blocks, stop reason, and token usage the model returned before the UI processed them. A lightweight inspector panel (modelled on the existing context inspector) would make this visible without requiring log diving.

## What Changes

- Each assistant message captures the raw API response data (content blocks, stop reason, model, usage) for each agent iteration
- A "Raw" button appears on assistant messages, opening an inspector overlay
- The inspector shows turns in order: content blocks (text, thinking, tool_use), stop reason, model, timestamps, and token usage
- A "Copy JSON" button exports the full raw data for external inspection

## Capabilities

### New Capabilities
- `raw-response-inspector`: Per-message overlay that exposes the raw LLM API response data (content blocks, stop reason, usage) for each agent iteration, accessible via a button on assistant messages

### Modified Capabilities
<!-- none -->

## Impact

- `src/provider.ts` — extend `ProviderResponse` to carry reconstructed content blocks
- `src/agent.ts` — accumulate raw turn data per conversation turn; add `onRawTurn` callback
- `src/protocol.ts` — new `RawTurnData` type; extend `DisplayMessage`; new `raw_turn` WebSocket event
- `src/server.ts` — broadcast `raw_turn` events; attach raw turns to final message
- `web/src/` — new modal component, button trigger, store state, ws-handler
- `web/style.css` — new `.rri-*` styles mirroring context inspector pattern
- No new dependencies; no breaking changes
