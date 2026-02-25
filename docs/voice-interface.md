# Voice Interface — Architecture & Status

> Voice in (STT) and voice out (TTS) for the web UI.
> Updated 2026-02-25. See `docs/web-ui-architecture.md` for full web UI architecture.

## Current Implementation

Voice is fully working in the main web UI (`localhost:3141`). The Chrome
extension sidepanel has known bugs — see `docs/web-ui-architecture.md` §4-5.

### Architecture

```
Browser (localhost:3141)
  ├─ Mic capture (Web Audio API, 16 kHz mono)
  ├─ VAD (RMS-based voice activity detection)
  ├─ Live chunked STT (12s rolling window, every 1.2s)
  │   └─ POST /stt (WAV) ──► Gatekeeper ──► Parakeet (localhost:8765)
  ├─ TTS playback (MP3 audio)
  │   └─ POST /tts (text) ──► Gatekeeper ──► Edge TTS (localhost:8766)
  └─ Auto-send on silence (sticky mode)
```

### STT Pipeline

| Component | Location | Purpose |
|-----------|----------|---------|
| `useMic.ts` | `web/src/hooks/` | Web Audio capture, VAD, chunked send |
| `/stt` endpoint | `src/web-bridge.ts` | Proxy to Parakeet STT service |
| Parakeet | `localhost:8765` | NVIDIA GPU STT (local) |

**How it works:**
1. `startMic()` opens `getUserMedia({ audio: { channelCount: 1 } })`.
2. `AudioContext` at 16 kHz, `ScriptProcessorNode` (4096 samples/frame).
3. VAD: RMS threshold → detects speech vs silence.
4. Every 1.2s, sends accumulated audio as WAV to `/stt`.
5. Maintains 12s rolling window — when exceeded, commits base text and starts fresh.
6. Sequence counter ensures only the latest STT response is displayed.
7. `stopMic()` sends final chunk for best-effort full transcription.

**Settings (configurable in web UI):**
- `mic_silence_threshold` — RMS threshold for speech detection
- `mic_loud_frames` — consecutive loud frames before VAD activates
- `mic_silence_tail_ms` — silence tail before VAD deactivates
- `mic_auto_send` — auto-submit after silence in sticky mode
- `mic_auto_send_ms` — silence duration before auto-submit

### TTS Pipeline

| Component | Location | Purpose |
|-----------|----------|---------|
| `useTTS.ts` | `web/src/hooks/` | Streams text events to TTS, plays MP3 |
| `/tts` endpoint | `src/web-bridge.ts` | Proxy to Edge TTS service |
| Edge TTS | `localhost:8766` | Microsoft Edge TTS (free, needs internet) |

**How it works:**
1. `useTTS` listens for streaming `text` events from the agent.
2. Periodically flushes accumulated text to `/tts?rate=<speed>`.
3. Receives MP3 audio, plays via `HTMLAudioElement`.
4. Auto-speak toggle: when enabled, speaks every assistant response.
5. Speed control: 0-100% rate adjustment.

### Sticky Mode (always-on mic)

When `micSticky` is true:
1. Mic stays recording after submission.
2. Auto-send: after N ms of silence, auto-submits the transcript.
3. Enables hands-free conversation loop: speak → agent responds → speak again.

### Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `web/src/hooks/useMic.ts` | ~316 | Core mic capture, VAD, STT |
| `web/src/hooks/useTTS.ts` | ~150 | TTS streaming, playback |
| `web/src/components/InputArea.tsx` | ~900 | Mic UI, BroadcastChannel sync |
| `web/src/stores/voice.ts` | ~50 | Mic/TTS state (Zustand) |
| `web/src/lib/audio.ts` | ~100 | WAV encoding, mic sounds |
| `src/web-bridge.ts` | — | /stt and /tts proxy endpoints |

## Extension Sidepanel Status

**Problem**: `getUserMedia` fails in Chrome extension sidepanel iframes
(user gesture restriction). Workaround: 4-hop relay chain that routes
mic commands to the main tab.

**Impact**: Mic buttons feel sluggish, state sync is fragile, conversation
doesn't reset cleanly.

**Fix strategy**: Test if Chrome now allows direct `getUserMedia` in
sidepanel iframes (the `allow="microphone *"` attribute is already set).
If yes, delete the relay. If no, harden the sync or move mic state to
server-mediated WebSocket events.

See `docs/web-ui-architecture.md` §4-6 for detailed analysis.

## Future Considerations

- **PWA for mobile**: Add manifest + service worker. Mic works natively in
  PWA context on both iOS and Android. No extension needed.
- **Local STT alternative**: Whisper.cpp for environments without NVIDIA GPU.
  Currently using Parakeet which requires CUDA.
- **Local TTS alternative**: Piper for fully offline TTS. Currently using
  Edge TTS which needs internet.
- **Voice profiles**: Per-profile TTS voice selection (personality).
- **Interrupt support**: Stop TTS when user starts speaking.
