## 1. Server-side: Capture raw turn data

- [x] 1.1 Add `RawContentBlock` type and `rawBlocks?: RawContentBlock[]` to `ProviderResponse` in `src/provider.ts`
- [x] 1.2 Reconstruct `rawBlocks` from `response.content` in `AnthropicProvider.sendMessage()`
- [x] 1.3 Reconstruct `rawBlocks` from accumulated streaming state in `OpenAIProvider.sendMessage()`
- [x] 1.4 Add `RawTurnData` interface and `rawTurns?: RawTurnData[]` to `DisplayMessage` in `src/protocol.ts`
- [x] 1.5 Add `raw_turn` event to `ServerEvent` union in `src/protocol.ts`
- [x] 1.6 Add `onRawTurn` callback to `ChatCallbacks` in `src/agent.ts`; call it after each `sendWithRetry()` iteration
- [x] 1.7 Pre-generate `assistantMsgId` in `server.ts` before calling `agent.chat()`; broadcast `raw_turn` events; attach `rawTurns` to final `DisplayMessage`

## 2. Browser: State and event handling

- [x] 2.1 Mirror `RawTurnData` type and extend `DisplayMessage` + `ServerEvent` in `web/src/types.ts`
- [x] 2.2 Add `rawTurnBuffer` map with `bufferRawTurn` / `drainRawTurns` to chat store (`web/src/stores/chat.ts`); exclude from persist
- [x] 2.3 Add `rawResponseMessage` state and setter to UI store (`web/src/stores/ui.ts`)
- [x] 2.4 Add `raw_turn` handler to `ws-handlers.ts`; update `message` handler to drain buffer into message on `finishStream`

## 3. UI: Inspector component and trigger

- [x] 3.1 Create `web/src/components/modals/RawResponseInspector.tsx` — overlay with turns, content blocks (text/thinking/tool_use), usage, Copy JSON button; pattern from `ContextInspector.tsx`
- [x] 3.2 Add Raw button trigger to assistant messages in `web/src/components/Message.tsx` (hidden when no `rawTurns`)
- [x] 3.3 Register `RawResponseInspector` portal in `web/src/components/App.tsx`
- [x] 3.4 Add `.rri-*` styles to `web/style.css` (backdrop, modal, header, body, turn sections, block types)

## 4. Tests and verification

- [x] 4.1 Add unit tests for `RawResponseInspector` component (render, open/close, copy button)
- [x] 4.2 Add unit tests for ws-handlers `raw_turn` buffering and drain behaviour
- [x] 4.3 Rebuild web UI: `rm -rf web/dist && npx vite build --outDir dist web/`
- [x] 4.4 Run `make check` — typecheck, unit tests, web build all pass (1 pre-existing tts-singleton failure unrelated to this change)
