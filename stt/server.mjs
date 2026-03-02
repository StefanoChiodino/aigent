#!/usr/bin/env node
/**
 * sherpa-onnx STT server — wraps Whisper or Zipformer behind a simple HTTP API.
 *
 * Usage:
 *     node stt/server.mjs [options]
 *
 *     --model-dir     path to extracted model (default: auto-detect in stt/)
 *     --host          bind address (default: 127.0.0.1)
 *     --port          listen port (default: 8765)
 *     --num-threads   inference threads (default: 2)
 *     --idle-timeout  seconds before unloading idle model (default 0 = never)
 *     --energy-threshold  RMS gate, audio quieter than this is skipped (default 0.01)
 *     --eager         load model at startup instead of on first request
 *
 * POST /transcribe   Content-Type: audio/wav   Body: raw WAV bytes (16kHz mono 16-bit PCM)
 *                    Response: {"text": "..."}
 * GET  /health       Response: {"status":"ok","model_loaded":true|false,"threads":2}
 * GET  /config       Response: {"energy_threshold":0.01}
 * POST /config       Body: {"energy_threshold":0.02}  → updates threshold
 */

import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sherpa_onnx from 'sherpa-onnx-node';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ─────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    host:              { type: 'string',  default: '127.0.0.1' },
    port:              { type: 'string',  default: process.env.AIGENT_STT_PORT ?? '8765' },
    'model-dir':       { type: 'string',  default: '' },
    'num-threads':     { type: 'string',  default: '2' },
    'idle-timeout':    { type: 'string',  default: process.env.AIGENT_STT_IDLE_TIMEOUT ?? '0' },
    'energy-threshold':{ type: 'string',  default: process.env.AIGENT_STT_ENERGY_THRESHOLD ?? '0.01' },
    eager:             { type: 'boolean', default: false },
  },
  strict: false,
});

const HOST = args.host;
const PORT = parseInt(args.port, 10);
const NUM_THREADS = parseInt(args['num-threads'], 10);
const IDLE_TIMEOUT = parseInt(args['idle-timeout'], 10);
let energyThreshold = parseFloat(args['energy-threshold']);

// ── Model directory auto-detection ──────────────────────────

function findModelDir() {
  if (args['model-dir']) return resolve(args['model-dir']);
  // Look for any sherpa-onnx-* directory inside stt/
  // Prefer whisper models over zipformer (better punctuation and real-world accuracy)
  const candidates = readdirSync(__dirname)
    .filter(d => d.startsWith('sherpa-onnx-') && existsSync(join(__dirname, d)))
    .sort((a, b) => {
      const aWhisper = a.includes('whisper') ? 0 : 1;
      const bWhisper = b.includes('whisper') ? 0 : 1;
      return aWhisper - bWhisper || a.localeCompare(b);
    });
  if (candidates.length > 0) return join(__dirname, candidates[0]);
  throw new Error(
    'No model found. Run: bash stt/download-model.sh\n' +
    'Or specify --model-dir /path/to/model'
  );
}

const MODEL_DIR = findModelDir();

/**
 * Detect model type from directory contents and build the recognizer config.
 */
function detectModelConfig() {
  const dirName = basename(MODEL_DIR);
  const files = readdirSync(MODEL_DIR);

  // Whisper model: has *-encoder.*.onnx and *-decoder.*.onnx
  const encoderFile = files.find(f => f.includes('encoder') && f.endsWith('.onnx'));
  const decoderFile = files.find(f => f.includes('decoder') && f.endsWith('.onnx'));
  const tokensFile = files.find(f => f.endsWith('-tokens.txt')) || files.find(f => f === 'tokens.txt');

  if (!tokensFile) throw new Error(`No tokens file found in ${MODEL_DIR}`);

  if (dirName.includes('whisper') && encoderFile && decoderFile) {
    // Prefer int8 if available
    const int8Encoder = files.find(f => f.includes('encoder') && f.includes('int8') && f.endsWith('.onnx'));
    const int8Decoder = files.find(f => f.includes('decoder') && f.includes('int8') && f.endsWith('.onnx'));
    return {
      type: 'whisper',
      config: {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: {
            encoder: join(MODEL_DIR, int8Encoder || encoderFile),
            decoder: join(MODEL_DIR, int8Decoder || decoderFile),
          },
          tokens: join(MODEL_DIR, tokensFile),
          numThreads: NUM_THREADS,
          provider: 'cpu',
          debug: 0,
        },
      },
    };
  }

  // Zipformer transducer: has encoder, decoder, joiner
  const joinerFile = files.find(f => f.includes('joiner') && f.endsWith('.onnx'));
  if (encoderFile && decoderFile && joinerFile) {
    const int8Encoder = files.find(f => f.includes('encoder') && f.includes('int8') && f.endsWith('.onnx'));
    const int8Joiner = files.find(f => f.includes('joiner') && f.includes('int8') && f.endsWith('.onnx'));
    return {
      type: 'zipformer',
      config: {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(MODEL_DIR, int8Encoder || encoderFile),
            decoder: join(MODEL_DIR, decoderFile),
            joiner: join(MODEL_DIR, int8Joiner || joinerFile),
          },
          tokens: join(MODEL_DIR, tokensFile),
          numThreads: NUM_THREADS,
          provider: 'cpu',
          debug: 0,
        },
      },
    };
  }

  throw new Error(`Cannot detect model type in ${MODEL_DIR}. Found files: ${files.join(', ')}`);
}

// ── WAV parsing & energy gate ───────────────────────────────

/**
 * Parse a WAV buffer and return Float32Array of samples + sample rate.
 * Supports standard PCM WAV (16-bit or 32-bit, mono).
 */
function parseWav(buf) {
  // RIFF header
  if (buf.length < 44) throw new Error('WAV too short');
  const riff = buf.toString('ascii', 0, 4);
  if (riff !== 'RIFF') throw new Error('Not a WAV file');

  // Find 'fmt ' and 'data' chunks
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  let i = 12; // skip RIFF header (12 bytes)
  while (i < buf.length - 8) {
    const chunkId = buf.toString('ascii', i, i + 4);
    const chunkSize = buf.readUInt32LE(i + 4);
    if (chunkId === 'fmt ') fmtOffset = i + 8;
    if (chunkId === 'data') { dataOffset = i + 8; dataSize = chunkSize; break; }
    i += 8 + chunkSize;
    if (chunkSize % 2 !== 0) i++; // padding byte
  }
  if (fmtOffset < 0 || dataOffset < 0) throw new Error('Invalid WAV: missing fmt/data chunks');

  const audioFormat = buf.readUInt16LE(fmtOffset);
  const channels = buf.readUInt16LE(fmtOffset + 2);
  const sampleRate = buf.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 14);

  if (audioFormat !== 1) throw new Error(`Unsupported WAV format: ${audioFormat} (expected PCM=1)`);
  if (channels !== 1) throw new Error(`Expected mono, got ${channels} channels`);

  const raw = buf.subarray(dataOffset, dataOffset + dataSize);

  let samples;
  if (bitsPerSample === 16) {
    const int16 = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    samples = new Float32Array(int16.length);
    for (let j = 0; j < int16.length; j++) samples[j] = int16[j] / 32768.0;
  } else if (bitsPerSample === 32) {
    const int32 = new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    samples = new Float32Array(int32.length);
    for (let j = 0; j < int32.length; j++) samples[j] = int32[j] / 2147483648.0;
  } else if (bitsPerSample === 8) {
    const uint8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
    samples = new Float32Array(uint8.length);
    for (let j = 0; j < uint8.length; j++) samples[j] = (uint8[j] - 128) / 128.0;
  } else {
    throw new Error(`Unsupported bits per sample: ${bitsPerSample}`);
  }

  return { samples, sampleRate };
}

/**
 * Compute RMS amplitude of Float32 samples (0.0–1.0).
 * Returns 0.0 on error so the gate fails open.
 */
function computeRms(samples) {
  if (!samples || samples.length === 0) return 0.0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// ── Transcript cleanup ───────────────────────────────────────

const FILLER_RE = /\b(um+|uh+|hmm+|hm+|mm-hmm|mhm+|mm+|ah+|er|erm|oh+)\b[,.]?/gi;

// Whisper special tokens and non-speech descriptors that should be stripped.
const WHISPER_NOISE_RE = /\[BLANK_AUDIO\]|\(buzzing\)|\(music\)|\(silence\)|\(noise\)|\(static\)|\(clicking\)|\(coughing\)|\(sighing\)/gi;

function clean(text) {
  text = text.replace(WHISPER_NOISE_RE, '');
  text = text.replace(FILLER_RE, ' ');
  text = text.replace(/ {2,}/g, ' ').trim();
  text = text.replace(/^[,.\s]+/, '');
  return text;
}

// ── Model lifecycle ─────────────────────────────────────────

let recognizer = null;
let modelType = null;
let unloadTimer = null;

function loadModel() {
  console.log(`Loading model from ${MODEL_DIR} (${NUM_THREADS} threads)...`);
  const t0 = Date.now();

  const detected = detectModelConfig();
  modelType = detected.type;
  recognizer = new sherpa_onnx.OfflineRecognizer(detected.config);
  console.log(`Model type: ${modelType}  Ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function unloadModel() {
  unloadTimer = null;
  if (recognizer) {
    console.log('Unloading model (idle timeout)...');
    recognizer = null;
    modelType = null;
  }
}

function resetIdleTimer() {
  if (IDLE_TIMEOUT <= 0) return;
  if (unloadTimer) clearTimeout(unloadTimer);
  unloadTimer = setTimeout(unloadModel, IDLE_TIMEOUT * 1000);
  unloadTimer.unref();
}

function getRecognizer() {
  if (!recognizer) loadModel();
  resetIdleTimer();
  return recognizer;
}

// ── HTTP server ─────────────────────────────────────────────

function jsonResponse(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  // GET /health
  if (req.method === 'GET' && url === '/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      model_loaded: recognizer !== null,
      model_type: modelType,
      threads: NUM_THREADS,
      model_dir: MODEL_DIR,
    });
    return;
  }

  // GET /config
  if (req.method === 'GET' && url === '/config') {
    jsonResponse(res, 200, { energy_threshold: energyThreshold });
    return;
  }

  // POST /config
  if (req.method === 'POST' && url === '/config') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      if ('energy_threshold' in body) {
        energyThreshold = parseFloat(body.energy_threshold);
        console.log(`[config] energy_threshold=${energyThreshold}`);
      }
      jsonResponse(res, 200, { energy_threshold: energyThreshold });
    } catch (err) {
      jsonResponse(res, 400, { error: String(err) });
    }
    return;
  }

  // POST /transcribe
  if (req.method === 'POST' && url === '/transcribe') {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      jsonResponse(res, 400, { error: 'failed to read body' });
      return;
    }

    if (!body || body.length === 0) {
      jsonResponse(res, 400, { error: 'empty body' });
      return;
    }

    // Parse WAV
    let wav;
    try {
      wav = parseWav(body);
    } catch (err) {
      jsonResponse(res, 400, { error: `WAV parse error: ${err.message}` });
      return;
    }

    // Energy gate
    let rms = -1;
    if (energyThreshold > 0) {
      rms = computeRms(wav.samples);
      if (rms < energyThreshold) {
        jsonResponse(res, 200, { text: '' });
        return;
      }
    }

    // Transcribe
    try {
      const rec = getRecognizer();
      const stream = rec.createStream();
      const t0 = Date.now();
      stream.acceptWaveform({ sampleRate: wav.sampleRate, samples: wav.samples });
      rec.decode(stream);
      const result = rec.getResult(stream);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

      let text = (result.text ?? '').trim();

      // Zipformer outputs ALL CAPS without punctuation — normalize to sentence case.
      // Whisper outputs properly cased+punctuated text — leave it alone.
      if (modelType === 'zipformer') {
        text = text.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, c) => pre + c.toUpperCase());
      }
      text = clean(text);

      const rmsStr = rms >= 0 ? `  rms=${rms.toFixed(4)}` : '';
      console.log(`[${elapsed}s]${rmsStr} ${JSON.stringify(text)}`);
      jsonResponse(res, 200, { text });
    } catch (err) {
      console.error('Transcription error:', err);
      jsonResponse(res, 500, { error: String(err) });
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end();
});

// ── Start ───────────────────────────────────────────────────

console.log(
  `STT server  model=${MODEL_DIR}  threads=${NUM_THREADS}  ` +
  `idle_timeout=${IDLE_TIMEOUT}s  energy_threshold=${energyThreshold}`
);

if (args.eager) getRecognizer();

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
});
