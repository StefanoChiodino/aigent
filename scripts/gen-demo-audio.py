#!/usr/bin/env python3
"""Pre-generate demo TTS audio files using edge-tts.

Run:  python scripts/gen-demo-audio.py
  or: make demo-audio

Outputs MP3 files to web/public/demo/ which are served as static assets
in the deployed demo (no TTS server needed at runtime).
"""

from __future__ import annotations

import asyncio
import io
import os
import sys

try:
    import edge_tts
except ImportError:
    print("Error: edge-tts not installed. Run: make tts-setup")
    sys.exit(1)

# ── Audio clips to generate ──────────────────────────────────────────────────
# Each entry: (filename, text, voice)
# The "user" voice must differ from the "agent" voice.

AGENT_VOICE = "en-US-AvaNeural"
USER_VOICE = "en-US-AndrewNeural"

CLIPS = [
    # Agent TTS response (short mode <speak> content)
    ("agent-response.mp3", "Health endpoint checks out — status ok, rate limiting active.", AGENT_VOICE),
    # Simulated user voice input (STT simulation)
    ("user-input.mp3", "Does the endpoint look right?", USER_VOICE),
]

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "public", "demo")


async def generate(filename: str, text: str, voice: str) -> None:
    buf = io.BytesIO()
    communicate = edge_tts.Communicate(text, voice, rate="+0%")
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    path = os.path.join(OUT_DIR, filename)
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    size = len(buf.getvalue())
    print(f"  {filename}: {size:,} bytes ({voice})")


async def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Generating demo audio → {os.path.relpath(OUT_DIR)}")
    for filename, text, voice in CLIPS:
        await generate(filename, text, voice)
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
