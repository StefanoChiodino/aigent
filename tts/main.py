#!/usr/bin/env python3
"""edge-tts TTS server — wraps Microsoft Edge neural TTS behind a simple HTTP API.

No API key needed. Uses the same protocol as the browser's Edge TTS service.

Usage:
    python tts/main.py [options]

    --voice   en-US-AvaNeural (default, or AIGENT_TTS_VOICE env var)
    --rate    speech rate, e.g. +25% (default +25%)
    --pitch   pitch adjustment, e.g. +2Hz (default +0Hz)
    --host    127.0.0.1
    --port    8766

POST /synthesize[?rate=+25%]
    Content-Type: text/plain
    Body: text to speak (plain text, markdown stripped by caller)
    Response: audio/mpeg (MP3)
    Optional query param: rate — overrides the server default for this request

GET /health
    Response: {"status": "ok", "voice": "..."}
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import urlparse, parse_qs

try:
    import edge_tts
except ImportError:
    print("Error: edge-tts not installed.")
    print("Install with: make tts-setup")
    import sys
    sys.exit(1)


# ── Global config ─────────────────────────────────────────────

_voice: str = "en-US-AvaNeural"
_rate: str = "+25%"
_pitch: str = "+0Hz"


# ── Synthesis ─────────────────────────────────────────────────

async def _synthesize(text: str, rate: str) -> bytes:
    """Synthesize text using edge-tts and return MP3 bytes."""
    buf = io.BytesIO()
    communicate = edge_tts.Communicate(text, _voice, rate=rate, pitch=_pitch)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    return buf.getvalue()


# ── HTTP handler ──────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass  # suppress per-request logging

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"status": "ok", "voice": _voice, "rate": _rate, "pitch": _pitch})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/synthesize":
            self.send_response(404)
            self.end_headers()
            return

        # Per-request rate override via ?rate=+25%
        params = parse_qs(parsed.query)
        rate = params.get("rate", [_rate])[0]

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if not body:
            self._json(400, {"error": "empty body"})
            return

        text = body.decode("utf-8").strip()
        if not text:
            self._json(400, {"error": "empty text"})
            return

        try:
            t0 = time.time()
            audio = asyncio.run(_synthesize(text, rate))
            elapsed = time.time() - t0
            print(f"[{elapsed:.2f}s] {len(audio):,} bytes, {len(text)} chars, rate={rate}", flush=True)

            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": str(e)})

    def _json(self, code: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ── Entry point ───────────────────────────────────────────────

def main() -> None:
    global _voice, _rate, _pitch

    parser = argparse.ArgumentParser(description="edge-tts TTS server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--voice",
        default=os.environ.get("AIGENT_TTS_VOICE", "en-US-AvaNeural"),
        help="Edge TTS voice name (default: en-US-AvaNeural)",
    )
    parser.add_argument("--rate", default="+25%", help="Default speech rate (default: +25%%)")
    parser.add_argument("--pitch", default="+0Hz", help="Pitch adjustment (default: +0Hz)")
    args = parser.parse_args()

    _voice = args.voice
    _rate = args.rate if args.rate.endswith("%") else args.rate + "%"
    _pitch = args.pitch

    print(f"TTS server  voice={_voice}  rate={_rate}  pitch={_pitch}", flush=True)

    server = HTTPServer((args.host, args.port), Handler)
    print(f"Listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down.", flush=True)


if __name__ == "__main__":
    main()
