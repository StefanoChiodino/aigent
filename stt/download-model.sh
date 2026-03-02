#!/usr/bin/env bash
# Download the sherpa-onnx Zipformer English model (int8 quantized).
# Skips download if the model directory already exists.

set -euo pipefail
cd "$(dirname "$0")"

MODEL_DIR="sherpa-onnx-zipformer-en-2023-06-26"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_DIR}.tar.bz2"

if [ -d "$MODEL_DIR" ] && [ -f "$MODEL_DIR/tokens.txt" ]; then
  echo "Model already exists at stt/$MODEL_DIR — skipping download."
else
  echo "Downloading $MODEL_DIR (~70 MB)..."
  curl -SL -o "${MODEL_DIR}.tar.bz2" "$MODEL_URL"
  echo "Extracting..."
  tar xf "${MODEL_DIR}.tar.bz2"
  rm -f "${MODEL_DIR}.tar.bz2"
  echo "Model ready at stt/$MODEL_DIR"
fi
