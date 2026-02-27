/**
 * Image and attachment utilities — parsing image paths in user messages,
 * base64 encoding, MIME type detection.
 *
 * Extracted from server.ts to keep it focused on orchestration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UserContent, TextContent, ImageContent, ImageMediaType } from './provider.js';

// --- Image support ---

export const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const IMAGE_PATH_REGEX = /(?:^|\s)(\/\S+\.(?:png|jpg|jpeg|gif|webp))\b/gi;

export function getImageMediaType(path: string): ImageMediaType | null {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

export function readImageBase64(filePath: string): { data: string; mediaType: ImageMediaType } | null {
  const resolved = resolve(filePath);
  const mediaType = getImageMediaType(resolved);
  if (!mediaType) return null;
  try {
    const buffer = readFileSync(resolved);
    return { data: buffer.toString('base64'), mediaType };
  } catch {
    return null;
  }
}

// --- Attachment support ---

export const IMAGE_TYPES_SET = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/javascript', 'application/typescript',
  'application/xml', 'application/yaml', 'application/x-yaml',
  'application/toml', 'application/x-sh',
]);

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime);
}

export const MAX_TEXT_FILE_SIZE = 500_000; // ~500KB decoded text limit

/**
 * Parse a user message for image file paths.
 * Returns UserContent — either a plain string (no images) or a mixed content array.
 */
export function parseImagesInMessage(text: string): UserContent {
  const matches: { path: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  IMAGE_PATH_REGEX.lastIndex = 0;
  while ((match = IMAGE_PATH_REGEX.exec(text)) !== null) {
    const path = match[1]!;
    // Verify file exists and is a valid image
    if (existsSync(path)) {
      const fullMatchStart = match.index + match[0].indexOf(path);
      matches.push({ path, start: fullMatchStart, end: fullMatchStart + path.length });
    }
  }

  if (matches.length === 0) return text;

  const parts: (TextContent | ImageContent)[] = [];
  let lastEnd = 0;

  for (const m of matches) {
    // Add text before this image
    if (m.start > lastEnd) {
      const textBefore = text.slice(lastEnd, m.start).trim();
      if (textBefore) parts.push({ type: 'text', text: textBefore });
    }

    const img = readImageBase64(m.path);
    if (img) {
      parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
    } else {
      // Failed to read — keep as text
      parts.push({ type: 'text', text: m.path });
    }
    lastEnd = m.end;
  }

  // Add remaining text
  if (lastEnd < text.length) {
    const remaining = text.slice(lastEnd).trim();
    if (remaining) parts.push({ type: 'text', text: remaining });
  }

  // If no images were actually loaded, return plain string
  if (parts.every((p) => p.type === 'text')) {
    return text;
  }

  // Ensure there's at least one text block (API requirement)
  if (!parts.some((p) => p.type === 'text')) {
    parts.push({ type: 'text', text: 'Describe this image.' });
  }

  return parts;
}
