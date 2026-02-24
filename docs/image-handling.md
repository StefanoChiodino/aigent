# Image & Attachment Handling

> Complete data flow for file attachments in aigent, from user input to LLM and back to the chat display.

## Overview

aigent supports attaching images (PNG, JPEG, GIF, WebP), PDFs, and text files to messages. Attachments flow through four layers:

```
Web UI (InputArea.tsx)
  → WebSocket JSON (connection store)
    → web-bridge.ts (gatekeeper)
      → server.ts → agent.ts → provider.ts → Anthropic/OpenAI API
```

There are **two parallel message histories**:

| Track | Type | Contains images? | Persisted where |
|-------|------|-----------------|-----------------|
| Agent messages | `ProviderMessage[]` | Yes (full base64) | `.autosave.json`, session saves |
| Display messages | `DisplayMessage[]` | **No** (text only) | localStorage (`aigent-chat`), `.autosave.json` |

This split means the LLM sees images correctly, but the chat UI only shows text placeholders like `[2 images] What is this?`. See [Known Issue](#known-issue-images-dont-persist-in-chat) below.

---

## 1. Input Methods

All input methods live in `web/src/components/InputArea.tsx`.

### File Picker
A hidden `<input type="file" multiple>` element (line ~572). Triggered by the "Attach" button. Accepts only `ALLOWED_TYPES`.

### Drag-and-Drop
`handleDrop` on the input area container (line ~524). Adds `.drag-over` CSS class for visual feedback during dragover.

### Clipboard Paste
`handlePaste` (line ~508) checks `clipboardData.items` for entries with `kind === 'file'` and a supported MIME type.

### Screen Capture
`handleScreenCap` (line ~315) uses the browser Screen Capture API:
1. Calls `startScreenShare()` from `web/src/lib/screen.ts` → `navigator.mediaDevices.getDisplayMedia()`
2. Pipes the `MediaStream` to a hidden `<video>` element
3. `captureScreenshot()` draws the current video frame to a `<canvas>` and exports as PNG base64

### Constraints
- **Allowed types**: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `text/markdown` (line 103-104)
- **Max attachments**: 5 per message (line 105)
- **MIME guessing**: If the browser doesn't provide a MIME type, `guessMime()` infers it from the file extension (line 109)

---

## 2. Client-Side Encoding

When a file is added via any method, `addFile()` (line ~291) processes it:

```
File → FileReader.readAsDataURL()
     → "data:image/png;base64,iVBORw0KGgo..."
     → split(',')[1] extracts raw base64
```

Two representations are stored on `PendingAttachment` (`web/src/types.ts:153-160`):

| Field | Content | Used for |
|-------|---------|----------|
| `data` | Raw base64 string (no prefix) | Sent to server |
| `dataUrl` | Full data URI (`data:image/png;base64,...`) | UI thumbnail preview (images only) |

### Attachment Preview

`AttachmentPreview.tsx` renders pending attachments before sending:
- **Images**: `<img src={att.dataUrl}>` thumbnail
- **Non-images**: File icon + name + size badge
- Each has a remove button

---

## 3. WebSocket Transport

When the user clicks Send, `submitMessage()` (line ~237) builds the WebSocket payload:

```typescript
{
  type: 'message',
  content: 'user text here',
  attachments: [
    { name: 'photo.png', mediaType: 'image/png', data: '<base64>' },
    { name: 'doc.pdf',   mediaType: 'application/pdf', data: '<base64>' }
  ]
}
```

Sent as `JSON.stringify()` over the WebSocket via `useConnectionStore.send()` (`web/src/stores/connection.ts:26-31`).

### Legacy Format

An older `images` field (`{ mediaType, data }[]`) is still supported for backward compatibility (`src/protocol.ts:20`).

---

## 4. Gatekeeper / Web Bridge

`src/web-bridge.ts:407-425` receives the WebSocket message and checks for attachments:

- **With attachments**: Forwards the full command (including `attachments` and/or `images`) directly to the sandbox via `client.send()`
- **Without attachments**: Routes through `client.sendMessage()` which intercepts slash commands

This means slash commands in messages with attachments bypass command interception — they're sent as plain messages.

---

## 5. Server Processing

`src/server.ts` handles the message in the `case 'message'` handler (line ~1438).

### Building UserContent (line 1448-1478)

When attachments are present, the server builds a `UserContent` array — a mix of typed content blocks:

| Attachment type | Content block | Details |
|----------------|---------------|---------|
| Image (PNG/JPEG/GIF/WebP) | `ImageContent` | `{ type: 'image', mediaType, data }` |
| PDF | `DocumentContent` | `{ type: 'document', mediaType: 'application/pdf', data, title }` |
| Text/Markdown | `TextContent` | Decoded from base64, truncated at 500KB, wrapped in `--- File: name ---` markers |
| Unsupported | `TextContent` | `[Unsupported file: name (type)]` |

The user's text message is appended as a final `TextContent` block (or `'Review these attachments.'` if no text).

### Building Display Text (line 1480-1490)

A human-readable label is generated: `"[2 images, 1 PDF] What is this?"`. This becomes the `displayText` passed to `processAgentTurn`.

### Type Definitions

Content block types are defined in `src/provider.ts`:

```typescript
interface ImageContent {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;  // base64
}

interface DocumentContent {
  type: 'document';
  mediaType: 'application/pdf';
  data: string;  // base64
  title?: string;
}

interface TextContent {
  type: 'text';
  text: string;
}

type UserContent = string | (TextContent | ImageContent | DocumentContent)[];
```

---

## 6. Agent & LLM Integration

### Message Queue

Messages are queued as `QueuedMessage` (line ~1347) and processed sequentially by `processQueue()` → `processMessage()` → `processAgentTurn()`.

### processAgentTurn (line ~608)

Creates a `DisplayMessage` with the text-only label and broadcasts it:

```typescript
const text = displayText ?? (typeof content === 'string' ? content : '[message with attachments]');
const userMsg: DisplayMessage = { role: 'user', content: text, timestamp: ... };
messages.push(userMsg);
broadcast({ type: 'message', message: userMsg });
```

Then calls `agent.chat(userContent)` with the full `UserContent` array (including base64 images).

### Anthropic API Format

`src/provider.ts:225-257` converts `ImageContent` to the Anthropic SDK format:

```typescript
{
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: '<base64>'
  }
}
```

### Image Deduplication

`src/agent.ts:579-589` — when the same image appears multiple times (e.g. repeated screenshots), it's deduplicated via SHA256 hash. Duplicate images are replaced with a text note: `[Same image as previously provided — already in context]`.

---

## 7. Persistence

### DisplayMessage (UI side)

```typescript
interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;     // plain text only — no binary data
  timestamp: string;
  elapsed?: number;
}
```

Persisted in two places:
- **localStorage**: Zustand `persist` middleware in `web/src/stores/chat.ts:131-134` saves `messages[]` under key `aigent-chat`
- **Autosave**: `src/profiles.ts:autoSaveSession()` writes `uiMessages[]` to `<workspace>/.autosave.json`

### ProviderMessage (agent side)

```typescript
type ProviderMessage =
  | { role: 'user'; content: UserContent }          // includes base64 images
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool_result'; results: ToolResult[] }
```

Persisted via autosave (`agentMessages[]` in `.autosave.json`). Contains full base64 image data. Restored on server restart (24-hour expiry).

### Session Saves

Manual `/save` writes both message tracks to `<workspace>/profiles/<name>/sessions/<id>.json`.

### Compaction

`src/compact.ts` explicitly strips base64 data before summarizing context. Image content blocks are replaced with `[+N image(s)]` counts.

---

## 8. On Reconnect / Page Reload

1. **Page reload**: Browser hydrates from localStorage → `useChatStore.messages` (text only)
2. **WebSocket connects**: Server sends `'connected'` event with `state.messages` (its `DisplayMessage[]`)
3. **Client receives**: `setMessages(event.state.messages)` overwrites localStorage data with server's view
4. **Server restart**: `.autosave.json` restores both `ProviderMessage[]` and `DisplayMessage[]`

---

## Known Issue: Images Don't Persist in Chat

**Symptom**: After sending a message with images, the chat shows `[2 images] What is this?` instead of actual image thumbnails. On reload, images are completely gone.

**Root cause**: The `DisplayMessage` type has `content: string` — no field for attachments or image data. When the server creates a `DisplayMessage` at `processAgentTurn` (server.ts:614-618), it discards the image data and stores only the text label.

**What works**: The LLM sees images correctly. Image data persists in `ProviderMessage[]` (`.autosave.json`). The issue is purely in the display/UI layer.

**What's needed**: Add an `attachments` field to `DisplayMessage` with small thumbnails (not full-res images). See `docs/implementation/2026-02-24-image-persistence.md` for the fix plan.

---

## Data Flow Diagram

```
User Action (file picker / drag-drop / paste / screenshot)
    │
    ▼
InputArea.tsx: addFile() / handleScreenCap()
    │  FileReader.readAsDataURL() → base64
    │
    ▼
PendingAttachment { data: base64, dataUrl: data:image/... }
    │
    ▼
AttachmentPreview.tsx: shows thumbnail / file badge
    │
    ▼
submitMessage() → WebSocket JSON
    │  { type: 'message', content, attachments: [{ name, mediaType, data }] }
    │
    ▼
web-bridge.ts → client.send()
    │
    ▼
server.ts: message handler
    │  ├─ Builds UserContent[] with ImageContent/DocumentContent/TextContent blocks
    │  ├─ Builds displayText: "[2 images] What is this?"
    │  └─ Creates DisplayMessage { content: displayText } ← images lost here
    │
    ├────────────────────────────────────────┐
    ▼                                        ▼
agent.chat(UserContent)               broadcast(DisplayMessage)
    │  SHA256 dedup                          │
    ▼                                        ▼
provider.ts → Anthropic API            Web UI → localStorage
    │  base64 image blocks                   │  text only
    ▼                                        ▼
LLM sees images correctly             Chat shows "[2 images]"
```
