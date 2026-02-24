# Plan: Image Persistence in Chat

**Date:** 2026-02-24
**Status:** Done

## Context

When a user attaches images to a message, the LLM receives them correctly, but the chat UI shows only a text placeholder like `[2 images] What is this?`. On page reload, images are completely gone.

**Root cause:** `DisplayMessage.content` is a plain string — image data never reaches the UI display or its persistence layer.

## Phase 1: Documentation

Create `docs/image-handling.md` documenting the complete image data flow across the stack.

### Content

1. **Input methods** — file picker, drag-drop, paste, screen capture (`InputArea.tsx`)
2. **Client-side encoding** — FileReader → base64, `PendingAttachment` type (`types.ts`)
3. **WebSocket transport** — JSON payload with `attachments` array (`protocol.ts`)
4. **Server processing** — converts to `ImageContent`/`DocumentContent` blocks (`server.ts`)
5. **LLM integration** — Anthropic API format, SHA256 dedup (`provider.ts`, `agent.ts`)
6. **Two-track history** — `ProviderMessage[]` (full, with images) vs `DisplayMessage[]` (text only)
7. **Persistence** — localStorage (text only), `.autosave.json` (full), session saves
8. **Known issue** — images discarded at `DisplayMessage` creation point

## Phase 2: Implementation

Add thumbnail-based image persistence to `DisplayMessage`:

1. Add `DisplayAttachment` type and `attachments?` field to `DisplayMessage` (both `src/protocol.ts` and `web/src/types.ts`)
2. Generate 200px JPEG thumbnails client-side via Canvas API before sending (`InputArea.tsx`)
3. Thread `displayAttachments` through server message handling (`server.ts`)
4. Render thumbnails in `Message.tsx` using existing `.message-images` / `.message-image-thumb` CSS
5. Zustand persist handles localStorage automatically — thumbnails are ~10-20KB each

### Files to Modify

| File | Change |
|------|--------|
| `docs/image-handling.md` | New — full data flow documentation |
| `src/protocol.ts` | `DisplayAttachment` interface, `attachments?` on `DisplayMessage` |
| `web/src/types.ts` | Mirror types, `thumbnail?` on `PendingAttachment` |
| `src/server.ts` | Thread attachments through message handler → `QueuedMessage` → `processAgentTurn` |
| `web/src/components/InputArea.tsx` | `generateThumbnail()`, include in WS payload |
| `web/src/components/Message.tsx` | Render thumbnails and file badges |
| `web/style.css` | `.message-file-badge` styles |

## Phase 3: E2E Tests

1. Attach image via file picker → thumbnail appears in chat
2. Attach via drag-and-drop → same
3. Attach via paste → same
4. Screen capture → thumbnail appears
5. Page reload → thumbnails persist from localStorage
6. Attach PDF → file badge (no thumbnail)
7. Message without attachments → no regression
8. Multiple images → all thumbnails in a row
9. Server reconnect → `getState()` delivers messages with attachments

## Verification

- Manual testing with all input methods
- `npx tsc --noEmit` passes
- E2E tests pass
