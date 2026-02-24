/**
 * Build script for the aigent Chrome extension.
 * Bundles each entry point (background worker, popup) to dist/.
 *
 * Usage:
 *   node build.mjs          — one-shot build
 *   node build.mjs --watch  — watch mode
 */

import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const outdir = resolve(__dirname, 'dist');
mkdirSync(outdir, { recursive: true });
mkdirSync(resolve(outdir, 'background'), { recursive: true });
mkdirSync(resolve(outdir, 'popup'), { recursive: true });
mkdirSync(resolve(outdir, 'icons'), { recursive: true });
mkdirSync(resolve(outdir, 'sidepanel'), { recursive: true });

// --- Icon generation ---
// Generates a minimal PNG filled with the aigent brand colour (#1a1a1a dark bg)
// with a white robot emoji-inspired shape. Good enough for the toolbar icon.
// Chrome requires PNG for action icons (SVG not supported).

function generatePNG(size) {
  const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const typeBytes = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput));
    return Buffer.concat([len, typeBytes, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, RGB

  // Draw a simple robot face: dark bg, rounded head, eyes, antenna
  // Pixel art scaled to 'size' using normalised coordinates [0,1]
  function pixel(x, y) {
    const nx = x / size, ny = y / size;
    // Background: #1a1a1a
    let pr = 26, pg = 26, pb = 26;

    // Head: rounded rect ~0.15..0.85 x, 0.2..0.85 y
    const inHead = nx > 0.15 && nx < 0.85 && ny > 0.2 && ny < 0.85;
    // Round corners (simple check)
    const corner =
      (nx < 0.22 && ny < 0.27) || (nx > 0.78 && ny < 0.27) ||
      (nx < 0.22 && ny > 0.78) || (nx > 0.78 && ny > 0.78);
    if (inHead && !corner) { pr = 255; pg = 255; pb = 255; }

    // Eyes: two small squares
    const leftEye  = nx > 0.27 && nx < 0.42 && ny > 0.38 && ny < 0.55;
    const rightEye = nx > 0.58 && nx < 0.73 && ny > 0.38 && ny < 0.55;
    if (leftEye || rightEye) { pr = 26; pg = 26; pb = 26; }

    // Mouth: bar
    const mouth = nx > 0.3 && nx < 0.7 && ny > 0.63 && ny < 0.72;
    if (mouth && inHead && !corner) { pr = 26; pg = 26; pb = 26; }

    // Antenna: thin vertical line + dot on top
    const antenna = nx > 0.47 && nx < 0.53 && ny > 0.08 && ny < 0.22;
    const antennaDot = nx > 0.42 && nx < 0.58 && ny > 0.04 && ny < 0.12;
    if (antenna || antennaDot) { pr = 255; pg = 255; pb = 255; }

    return [pr, pg, pb];
  }

  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 3)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (1 + size * 3) + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }

  const compressed = deflateSync(raw);
  return Buffer.concat([
    PNG_HEADER,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(resolve(outdir, `icons/icon${size}.png`), generatePNG(size));
}
console.log('Icons generated');

// Copy static files
const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['popup/popup.html', 'popup/popup.html'],
];

for (const [src, dest] of staticFiles) {
  const srcPath = resolve(__dirname, src);
  const destPath = resolve(outdir, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
  }
}

const entryPoints = [
  { in: resolve(__dirname, 'background/worker.ts'), out: resolve(outdir, 'background/worker') },
  { in: resolve(__dirname, 'popup/popup.ts'), out: resolve(outdir, 'popup/popup') },
];

const buildOptions = {
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context({
    ...buildOptions,
    entryPoints: entryPoints.map(e => ({ in: e.in, out: e.out })),
    outdir: outdir,
    entryNames: '[dir]/[name]',
  });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  for (const entry of entryPoints) {
    await esbuild.build({
      ...buildOptions,
      entryPoints: [entry.in],
      outfile: `${entry.out}.js`,
    });
  }
  console.log('Build complete → dist/');
}
