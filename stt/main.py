#!/usr/bin/env python3
"""Parakeet STT server — wraps nvidia/parakeet-tdt-0.6b-v2 behind a simple HTTP API.

Usage:
    python stt/main.py [options]

    --model         nvidia/parakeet-tdt-0.6b-v2 (default)
    --device        auto | cuda | mps | cpu
    --idle-timeout  seconds before unloading idle model (default 300, 0=never)
    --eager         load model at startup instead of on first request

POST /transcribe
    Content-Type: audio/wav
    Body: raw WAV bytes (16kHz, mono, 16-bit PCM)
    Response: {"text": "..."}

GET /health
    Response: {"status": "ok", "model_loaded": true|false, "device": "cuda"}
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import re
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Protocol, cast


class _ASRModel(Protocol):
    """Structural type covering the NeMo ASR model interface we actually use."""
    cfg: Any  # OmegaConf DictConfig — no stubs available

    def eval(self) -> Any: ...
    def to(self, device: str) -> _ASRModel: ...
    def transcribe(
        self,
        audio: list[str],
        batch_size: int = ...,
        num_workers: int = ...,
        verbose: bool = ...,
    ) -> list[Any]: ...


# ── Global state ──────────────────────────────────────────────

_model: _ASRModel | None = None
_model_lock: threading.Lock = threading.Lock()
_model_name: str = "nvidia/parakeet-tdt-0.6b-v2"
_device: str = "cpu"
_idle_timeout: int = 300
_unload_timer: threading.Timer | None = None


# ── Device detection ──────────────────────────────────────────

def _pick_device() -> str:
    try:
        import torch  # type: ignore[import-untyped]
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


# ── Model lifecycle ───────────────────────────────────────────

def _load() -> None:
    global _model
    print(f"Loading {_model_name} on {_device}...", flush=True)
    t0: float = time.time()
    import nemo.collections.asr as nemo_asr  # type: ignore[import-untyped]

    # EncDecRNNTBPEModel is the correct class for parakeet-tdt models.
    # ASRModel.from_pretrained is a generic loader that can fail with TDT variants.
    # Load via the specific TDT class; fall back to the generic loader.
    # NeMo has no type stubs — from_pretrained() is `str | Unknown` in Pylance.
    # type: ignore is the correct escape hatch here; cast() communicates intent to readers.
    model: _ASRModel
    try:
        model = cast(_ASRModel, nemo_asr.models.EncDecRNNTBPEModel.from_pretrained(model_name=_model_name))  # type: ignore[reportUnknownMemberType]
    except Exception:
        model = cast(_ASRModel, nemo_asr.models.ASRModel.from_pretrained(model_name=_model_name))  # type: ignore[reportUnknownMemberType]

    model.eval()
    if _device != "cpu":
        try:
            model = model.to(_device)
        except Exception as e:
            print(f"Cannot move to {_device}: {e} — falling back to CPU", flush=True)

    # _setup_transcribe_dataloader() hardcodes 'use_lhotse': True in the dl_config
    # dict it builds fresh — patching model.cfg has no effect.  Instead we
    # monkey-patch _setup_dataloader_from_config on the instance so that
    # use_lhotse is forced off before the lhotse/standard branch is taken.
    # The lhotse DynamicCutSampler has a dataclass __init__ bug that crashes
    # inference; the standard AudioToCharDataset path works fine.
    import types
    from omegaconf import open_dict, DictConfig  # type: ignore[import-untyped]

    _orig_setup_dl = type(model)._setup_dataloader_from_config  # type: ignore[attr-defined]

    def _setup_dataloader_no_lhotse(self: Any, config: Any) -> Any:
        if isinstance(config, DictConfig):
            with open_dict(config):
                config["use_lhotse"] = False
        elif isinstance(config, dict):
            config["use_lhotse"] = False
        return _orig_setup_dl(self, config)  # type: ignore[no-any-return]

    model._setup_dataloader_from_config = types.MethodType(  # type: ignore[attr-defined]
        _setup_dataloader_no_lhotse, model
    )
    print("Patched _setup_dataloader_from_config to disable Lhotse.", flush=True)

    # CUDA graph compilation fails at inference time with a version mismatch
    # (cu_call returns 5 values, code expects 6).  Disable CUDA graphs on the
    # TDT label-looping decoding computer if present.
    try:
        model.decoding.decoding.decoding_computer.disable_cuda_graphs()  # type: ignore[attr-defined]
        print("Disabled CUDA graphs for TDT decoding.", flush=True)
    except AttributeError:
        pass

    _model = model
    print(f"Model ready in {time.time() - t0:.1f}s", flush=True)


def _unload() -> None:
    global _model, _unload_timer
    _unload_timer = None
    if _model is not None:
        print("Unloading model (idle timeout)...", flush=True)
        _model = None
        gc.collect()
        try:
            import torch  # type: ignore[import-untyped]
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


def _reset_idle_timer() -> None:
    global _unload_timer
    if _idle_timeout <= 0:
        return
    if _unload_timer is not None:
        _unload_timer.cancel()
    _unload_timer = threading.Timer(_idle_timeout, _unload)
    _unload_timer.daemon = True
    _unload_timer.start()


def get_model() -> _ASRModel:
    """Return the loaded model, loading lazily on first call."""
    with _model_lock:
        if _model is None:
            _load()
        assert _model is not None
        _reset_idle_timer()
        return _model


# ── Transcript post-processing ────────────────────────────────

# Standalone filler words to strip (whole-word, case-insensitive).
_FILLER_RE = re.compile(
    r'\b(um+|uh+|hmm+|hm+|mm-hmm|mhm+|mm+|ah+|er|erm|oh+)\b[,.]?',
    re.IGNORECASE,
)

def _clean(text: str) -> str:
    """Strip filler words and tidy up whitespace/punctuation."""
    text = _FILLER_RE.sub(' ', text)
    # Collapse runs of spaces and strip leading/trailing whitespace.
    text = re.sub(r'  +', ' ', text).strip()
    # Remove a leading comma or period left behind after stripping.
    text = re.sub(r'^[,.\s]+', '', text)
    return text


# ── HTTP handler ──────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass  # suppress per-request logging

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok", "model_loaded": _model is not None, "device": _device})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return

        length: int = int(self.headers.get("Content-Length", 0))
        body: bytes = self.rfile.read(length)

        if not body:
            self._json(400, {"error": "empty body"})
            return

        tmpfile: str | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(body)
                tmpfile = f.name

            model: Any = get_model()
            t0: float = time.time()
            result: list[Any] = model.transcribe([tmpfile], batch_size=1, num_workers=0, verbose=False)
            elapsed: float = time.time() - t0

            r: Any = result[0]
            text: str
            if isinstance(r, str):
                text = r
            elif hasattr(r, "text"):
                text = r.text
            else:
                text = str(r)

            text = _clean(text)
            print(f"[{elapsed:.2f}s] {text!r}", flush=True)
            self._json(200, {"text": text})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": str(e)})
        finally:
            if tmpfile and os.path.exists(tmpfile):
                os.unlink(tmpfile)

    def _json(self, code: int, data: dict[str, Any]) -> None:
        body: bytes = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ── Entry point ───────────────────────────────────────────────

def main() -> None:
    global _model_name, _device, _idle_timeout

    parser = argparse.ArgumentParser(description="Parakeet STT server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="nvidia/parakeet-tdt-0.6b-v2",
                        help="NeMo model name or local .nemo path")
    parser.add_argument("--device", default="auto",
                        help="cuda | mps | cpu | auto (default: auto-detect)")
    parser.add_argument("--idle-timeout", type=int,
                        default=int(os.environ.get("AIGENT_STT_IDLE_TIMEOUT", "0")),
                        help="Unload model after N seconds idle (0 = never, default 0 / env: AIGENT_STT_IDLE_TIMEOUT)")
    parser.add_argument("--eager", action="store_true",
                        help="Load model at startup rather than on first request")
    args = parser.parse_args()

    _model_name = args.model
    _device = _pick_device() if args.device == "auto" else args.device
    _idle_timeout = args.idle_timeout

    print(f"STT server  model={_model_name}  device={_device}  idle_timeout={_idle_timeout}s", flush=True)

    if args.eager:
        get_model()

    server: HTTPServer = HTTPServer((args.host, args.port), Handler)
    print(f"Listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down.", flush=True)


if __name__ == "__main__":
    main()
