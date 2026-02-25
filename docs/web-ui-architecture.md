# Web UI & Chrome Extension — Architecture

> How the browser UI works, how the Chrome extension integrates,
> and the key design decisions.
> Updated 2026-02-25 — sidepanel replaced with popup window.

---

## 1. Overview

The web UI is a **React 19 + Zustand** single-page app built with Vite,
served from `web/dist/` by the gatekeeper's HTTP server on port 3141.

The Chrome extension opens the **same app** in a popup window via
`chrome.windows.create({ type: 'popup' })`. This is a normal browser
window with full API access — `getUserMedia`, Web Audio, etc. all work
natively. No iframe, no relay chain, no `isSidepanel` branches.

```
┌──────────────────────────────────────────────────────┐
│ Chrome browser                                        │
│                                                       │
│  ┌──────────────────┐   ┌──────────────────────┐     │
│  │ Main tab          │   │ Extension popup window│     │
│  │ localhost:3141    │   │ localhost:3141         │     │
│  │                   │   │                       │     │
│  │  React app        │   │  React app (same)     │     │
│  │  getUserMedia ✓   │   │  getUserMedia ✓       │     │
│  └──────────────────┘   └──────────────────────┘     │
│                                                       │
│  background/worker.ts                                 │
│  ├── WebSocket to /ext (a11y + screenshot bridge)     │
│  ├── Popup window management (open/focus)             │
│  └── Keep-alive alarm                                 │
└──────────────────────────────────────────────────────┘
         ↕ WebSocket /ws (both windows share)
         ↕ WebSocket /ext (background worker only)
┌──────────────────────────────────────────────────────┐
│ WSL2 — Gatekeeper (Node.js)                           │
│  src/web-bridge.ts  — HTTP server + /ws + /ext        │
│  src/ext-bridge.ts  — extension command relay         │
└──────────────────────────────────────────────────────┘
```

## 2. Why Popup Window (Not Sidepanel)

The previous architecture used a Chrome extension sidepanel with an iframe
embedding `localhost:3141`. This caused:

1. **`getUserMedia` blocked** — Chrome denies mic access in extension iframe
   context, requiring a 4-hop relay chain through the background worker to
   the main tab.
2. **State sync bugs** — mic state lived in two places (main tab + sidepanel),
   synced via BroadcastChannel. Race conditions caused conversation accumulation,
   input cursor misalignment, and unresponsive mic buttons.
3. **~100 lines of `isSidepanel` branches** — conditional code in InputArea.tsx
   for the relay chain, all of which was fragile and hard to test.

The popup window approach eliminates all of this. It's a normal browser window
with full API access — identical to opening `localhost:3141` in a tab.

## 3. Extension Architecture

### Background Worker (`background/worker.ts`)

The service worker maintains:
- **WebSocket to `/ext`** — persistent connection to gatekeeper for a11y
  extraction and screenshot capture
- **Popup window management** — `chrome.windows.create()` / focus, tracked
  via `aigentWindowId`
- **Keep-alive alarm** — `chrome.alarms` every ~25s to prevent MV3 service
  worker termination

### Popup (`popup/popup.html` + `popup.ts`)

Simple status indicator + "Open aigent" button. Shows connection status
(whether WebSocket to gatekeeper is alive). The button sends
`chrome.runtime.sendMessage({ type: 'open-window' })` to the background
worker which creates/focuses the popup window.

### Build

```bash
npm run ext:build  # outputs to aigent-extension/dist/
# Load in Chrome: Extensions → Load unpacked → aigent-extension/dist/
```

## 4. File Reference

### Web UI
| File | Purpose |
|------|---------|
| `web/index.html` | Entry point, loads main.tsx |
| `web/src/main.tsx` | React bootstrap, test hooks on window |
| `web/src/components/App.tsx` | Root: header, sidebar, chat, input, modals |
| `web/src/components/InputArea.tsx` | Text input, mic, attachments, send |
| `web/src/components/ChatArea.tsx` | Message list + streaming response |
| `web/src/hooks/useMic.ts` | Web Audio capture, VAD, live STT streaming |
| `web/src/hooks/useTTS.ts` | Text-to-speech playback |
| `web/src/hooks/useWebSocket.ts` | Server connection + event dispatch |
| `web/src/stores/chat.ts` | Messages, streaming, usage, tasks |
| `web/src/stores/ui.ts` | Errors, modals, permissions, mounts |
| `web/src/stores/voice.ts` | Mic state, TTS state, sticky mode |
| `web/src/stores/connection.ts` | WebSocket ref, reconnect logic |
| `web/src/stores/settings.ts` | Client/server settings persistence |
| `web/style.css` | All styling |

### Extension
| File | Purpose |
|------|---------|
| `aigent-extension/manifest.json` | MV3 manifest, permissions |
| `aigent-extension/background/worker.ts` | Service worker: /ext WS, a11y, screenshot, popup window |
| `aigent-extension/popup/popup.html` | Status + "Open aigent" button |
| `aigent-extension/popup/popup.ts` | Popup logic |
| `aigent-extension/build.mjs` | esbuild for extension |

### Server
| File | Purpose |
|------|---------|
| `src/web-bridge.ts` | HTTP server, /ws + /ext WebSocket, STT/TTS proxy, file search |
| `src/ext-bridge.ts` | Extension command relay (a11y, screenshot) |
| `src/gatekeeper.tsx` | Host process entry point, imports web-bridge dynamically |

## 5. Build & Dev

```bash
# Build web UI (required after editing web/src/ or web/style.css)
rm -rf web/dist && npx vite build --outDir dist web/

# Build extension (required after editing aigent-extension/)
npm run ext:build  # outputs to aigent-extension/dist/

# Dev server (auto-rebuilds web UI, proxies to gatekeeper)
npx vite dev web/

# Load extension: Chrome → Extensions → Load unpacked → aigent-extension/dist/
```

**Gotcha**: `web-bridge.ts` is dynamically imported by `gatekeeper.tsx`.
tsx `--watch` doesn't detect changes to dynamically imported files.
After editing `web-bridge.ts`, make a trivial edit to `gatekeeper.tsx`
to force a restart.
