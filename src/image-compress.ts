/**
 * Image compression utilities — downscale and re-encode images before sending
 * to the LLM API, reducing token cost and wire size.
 *
 * Anthropic re-encodes and tokenizes images by pixel dimensions (max 1568px
 * per side, ~1.15M total pixels). Sending larger images is pure waste.
 */

import sharp from 'sharp';
import type { ImageMediaType } from './provider.js';

/** Anthropic's max useful image dimension — larger images are re-encoded server-side. */
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 80;
/** Skip compression for images already under this byte count AND within dimension limits. */
const MIN_BYTES_THRESHOLD = 100_000;

export interface CompressedImage {
  data: string;        // base64
  mediaType: ImageMediaType;
}

/**
 * Compress and optionally downscale a base64-encoded image.
 * - Downscales to max 1568px on longest side (Anthropic's max useful resolution)
 * - Converts non-alpha PNGs to JPEG at quality 80
 * - Preserves PNG for images with alpha channels
 * - Returns original unchanged if already small enough
 */
export async function compressImage(
  base64Data: string,
  mediaType: ImageMediaType,
): Promise<CompressedImage> {
  const buffer = Buffer.from(base64Data, 'base64');

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    // Can't read metadata — return original
    return { data: base64Data, mediaType };
  }

  const w = metadata.width ?? 0;
  const h = metadata.height ?? 0;

  // Already small enough — no work needed
  if (w <= MAX_DIMENSION && h <= MAX_DIMENSION && buffer.length < MIN_BYTES_THRESHOLD) {
    return { data: base64Data, mediaType };
  }

  const hasAlpha = metadata.channels === 4 && metadata.format === 'png';

  try {
    let pipeline = sharp(buffer).resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    });

    if (hasAlpha) {
      // Preserve transparency
      const out = await pipeline.png({ effort: 4 }).toBuffer();
      return { data: out.toString('base64'), mediaType: 'image/png' };
    } else {
      // Convert to JPEG for best compression
      const out = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
      return { data: out.toString('base64'), mediaType: 'image/jpeg' };
    }
  } catch {
    // Compression failed — return original
    return { data: base64Data, mediaType };
  }
}
