# Voice Interface — Design Notes

## Goal
Talk to the agent naturally — voice in, voice out. No typing, no external STT app.

## Architecture: Web Audio Bridge

Preferred approach: thin web UI handles audio I/O, container handles everything else.

```
Browser (localhost:3000)
  ├─ Mic capture (Web Audio API)
  ├─ WebSocket ──► Container
  │                 ├─ Whisper.cpp (STT) → text
  │                 ├─ Agent processes text
  │                 ├─ Piper / Edge TTS → audio
  │                 └─ WebSocket ◄── audio back
  └─ Plays audio response
```

- Works on any OS, no audio driver issues
- Accessible from phone/tablet too
- TUI still works in parallel for text interaction

## STT Options

| Option | Local? | Size | Quality | Notes |
|--------|--------|------|---------|-------|
| Whisper.cpp | Yes | ~1GB | Excellent | Best local option, C++ with Node bindings |
| NVIDIA Parakeet | Yes | ~600MB | Very good | Needs NVIDIA GPU |
| OpenAI Whisper API | No | — | Excellent | Simple but cloud, costs money |
| Deepgram | No | — | Excellent | Cloud, fast streaming |

**Recommendation**: Whisper.cpp — runs locally, no API key, accurate enough.

## TTS Options

| Option | Local? | Quality | Speed | Notes |
|--------|--------|---------|-------|-------|
| Piper | Yes | Good | Very fast | Lightweight, many voices |
| Edge TTS | No* | Very good | Fast | Free Microsoft API, needs internet |
| ElevenLabs | No | Excellent | Medium | Best quality, paid |
| OpenAI TTS | No | Very good | Medium | Cloud, costs money |
| Coqui TTS | Yes | Good | Slow | Heavier than Piper |

*Edge TTS is free with no API key, just needs network.

**Recommendation**: Piper for fully local, Edge TTS if internet is acceptable.

## Alternative: PulseAudio Passthrough

Mount host PulseAudio socket into Docker for direct mic/speaker access.
More native but fragile on WSL2, needs host-side config.
Only consider if web approach isn't good enough.

## Implementation Steps (when ready)

1. Add Whisper.cpp and Piper to Dockerfile
2. WebSocket server in the container (ws library)
3. Simple HTML page served from container (express or static)
4. Audio pipeline: mic → Whisper → agent → TTS → playback
5. Voice activation / push-to-talk toggle
6. Streaming TTS (start speaking before full response is ready)

## Open Questions

- Push-to-talk vs voice activity detection?
- Should the agent's "personality" include a voice? (voice selection per profile)
- Interrupt support? (stop speaking when user starts talking)
