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
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const outdir = resolve(__dirname, 'dist');
mkdirSync(outdir, { recursive: true });
mkdirSync(resolve(outdir, 'background'), { recursive: true });
mkdirSync(resolve(outdir, 'popup'), { recursive: true });
mkdirSync(resolve(outdir, 'icons'), { recursive: true });

// --- Icon generation ---
// Renders the same SVG as the web favicon (🤖 emoji, transparent bg) to PNG.
// Uses rsvg-convert (librsvg, available on host). Chrome requires PNG for icons.

function generateIconSVG(size) {
  // Identical to web/index.html favicon: transparent bg, full-size emoji
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <text y=".9em" font-size="90">&#x1F916;</text>
</svg>`;
}

function svgToPng(svgStr, size) {
  // rsvg-convert on this system doesn't support stdin ('-'), so write to a temp file
  const tmpSvg = resolve(tmpdir(), `aigent-icon-${size}-${randomBytes(4).toString('hex')}.svg`);
  writeFileSync(tmpSvg, svgStr);
  try {
    const result = spawnSync('rsvg-convert', [
      '--width', String(size),
      '--height', String(size),
      '--format', 'png',
      tmpSvg,
    ]);
    if (result.status !== 0 || !result.stdout?.length) {
      throw new Error(result.stderr?.toString() ?? 'rsvg-convert failed');
    }
    return result.stdout;
  } catch (e) {
    console.warn(`rsvg-convert failed for size ${size} (${e.message}) — using plain dark PNG fallback`);
    return generateFallbackPNG(size);
  } finally {
    try { execFileSync('rm', ['-f', tmpSvg]); } catch {}
  }
}

function generateFallbackPNG(size) {
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
    const tb = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const ci = Buffer.concat([tb, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(ci));
    return Buffer.concat([len, tb, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(size * (1 + size * 3), 26); // fill #1a1a1a
  for (let y = 0; y < size; y++) raw[y * (1 + size * 3)] = 0;
  return Buffer.concat([PNG_HEADER, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 48, 128]) {
  const svg = generateIconSVG(size);
  const png = svgToPng(svg, size);
  writeFileSync(resolve(outdir, `icons/icon${size}.png`), png);
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
