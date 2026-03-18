## Context

The agent processes LLM responses through `provider.ts` → `agent.ts` → `server.ts` → WebSocket → browser. By the time the browser renders a message, the raw API structure (content blocks, stop reason, per-iteration usage) has been flattened. The existing context inspector (`ContextInspector.tsx`, ~300 lines + ~464 lines CSS) is the direct UI pattern to follow — same modal overlay, same fade-in animation, same expandable-row structure.

## Goals / Non-Goals

**Goals:**
- Capture raw content blocks + metadata per agent iteration at the provider layer
- Attach that data to the `DisplayMessage` so it persists in localStorage
- Surface it via a lightweight inspector overlay that follows the context inspector pattern exactly

**Non-Goals:**
- Streaming delta-level inspection (impractical; `finalMessage()` is the right granularity)
- Verbatim Anthropic SDK `Message` object (contains duplicate base64 image bytes; reconstructed blocks are equivalent for learning purposes)
- Any server-side persistence beyond what is already on the message

## Decisions

**D1: Reconstruct blocks at provider layer, not raw SDK object**
The Anthropic `Message` object contains base64 image bytes already sent to the browser via tool results. Storing it verbatim would double the payload size. A reconstructed `RawContentBlock[]` captures identical structure with no redundancy.
_Alternative considered_: Store verbatim JSON. Rejected due to image duplication and internal SDK metadata noise.

**D2: Attach raw turns directly to `DisplayMessage`**
Storing `rawTurns` on the message means they persist in `localStorage` automatically — no separate store, no migration, no extra fetch. Old messages simply lack the field and show no button.
_Alternative considered_: Separate Zustand store keyed by message ID. Rejected as unnecessary complexity.

**D3: Broadcast `raw_turn` WebSocket events per iteration, buffer in browser**
Each `raw_turn` event is sent immediately when an iteration completes (before the final `message` event). The browser buffers by message ID and drains into the message on `finishStream`. This mirrors the existing `tool_start`/`tool_end` event pattern and means partial data is available even if a long run is interrupted.
_Alternative considered_: Include raw turns inline in the final `message` event. Works fine but loses the incremental delivery pattern.

**D4: Pre-generate message ID in server before `agent.chat()`**
`raw_turn` events need to reference the message ID before it exists. Generating the ID upfront (as a random hex string) allows correlation between events. This is a minor server-side change with no protocol impact.

**D5: Mirror ContextInspector CSS class prefix `.rri-*`**
Keeps style.css organised by feature. The inspector overlay structure (backdrop → modal → header → body) is identical to the context inspector; reusing the same layout approach avoids new patterns.

## Risks / Trade-offs

- [Risk] localStorage growth for long tool-heavy sessions → Mitigation: raw blocks are text-only (no images); a typical session adds negligible bytes
- [Risk] OpenAI provider has no native `content[]` block structure → Mitigation: reconstruct from accumulated streaming state (currentText, toolCallAccum, currentReasoning) before returning; already available in the provider loop
- [Risk] Message ID must be pre-generated → Mitigation: trivial change; IDs are already random hex strings

## Open Questions

- None — scope is fully bounded by the context inspector precedent.
