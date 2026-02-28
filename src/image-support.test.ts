/**
 * Image support — tests for MIME type detection, base64 encoding,
 * text MIME detection, and image path parsing in messages.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getImageMediaType,
  readImageBase64,
  isTextMime,
  parseImagesInMessage,
  IMAGE_EXTENSIONS,
  IMAGE_PATH_REGEX,
  IMAGE_TYPES_SET,
  MAX_TEXT_FILE_SIZE,
} from './image-support.js';

describe('getImageMediaType', () => {
  it('returns correct type for .png', () => {
    assert.equal(getImageMediaType('/path/to/image.png'), 'image/png');
  });

  it('returns correct type for .jpg', () => {
    assert.equal(getImageMediaType('/path/to/photo.jpg'), 'image/jpeg');
  });

  it('returns correct type for .jpeg', () => {
    assert.equal(getImageMediaType('/path/to/photo.jpeg'), 'image/jpeg');
  });

  it('returns correct type for .gif', () => {
    assert.equal(getImageMediaType('/path/to/anim.gif'), 'image/gif');
  });

  it('returns correct type for .webp', () => {
    assert.equal(getImageMediaType('/path/to/modern.webp'), 'image/webp');
  });

  it('handles uppercase extensions', () => {
    assert.equal(getImageMediaType('/path/to/IMAGE.PNG'), 'image/png');
  });

  it('handles mixed case', () => {
    assert.equal(getImageMediaType('/path/to/photo.JpG'), 'image/jpeg');
  });

  it('returns null for unknown extension', () => {
    assert.equal(getImageMediaType('/path/to/doc.pdf'), null);
  });

  it('returns null for no extension', () => {
    assert.equal(getImageMediaType('/path/to/noext'), null);
  });

  it('uses last dot for extension', () => {
    assert.equal(getImageMediaType('/path/to/file.backup.png'), 'image/png');
  });
});

describe('isTextMime', () => {
  it('recognizes text/* types', () => {
    assert.equal(isTextMime('text/plain'), true);
    assert.equal(isTextMime('text/html'), true);
  });

  it('recognizes application types in TEXT_MIME_TYPES', () => {
    assert.equal(isTextMime('application/json'), true);
    assert.equal(isTextMime('application/javascript'), true);
    assert.equal(isTextMime('application/typescript'), true);
    assert.equal(isTextMime('application/yaml'), true);
    assert.equal(isTextMime('application/toml'), true);
    assert.equal(isTextMime('application/x-sh'), true);
  });

  it('rejects binary types', () => {
    assert.equal(isTextMime('image/png'), false);
    assert.equal(isTextMime('application/octet-stream'), false);
    assert.equal(isTextMime('application/pdf'), false);
  });
});

describe('readImageBase64', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'img-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and base64-encodes a PNG file', () => {
    const filePath = join(tmpDir, 'test.png');
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(filePath, content);

    const result = readImageBase64(filePath);
    assert.ok(result);
    assert.equal(result.mediaType, 'image/png');
    assert.equal(result.data, content.toString('base64'));
  });

  it('returns null for non-image extension', () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'hello');
    assert.equal(readImageBase64(filePath), null);
  });

  it('returns null for non-existent file', () => {
    assert.equal(readImageBase64(join(tmpDir, 'missing.png')), null);
  });
});

describe('parseImagesInMessage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parse-img-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns plain string when no image paths', () => {
    const result = parseImagesInMessage('Hello, no images here.');
    assert.equal(result, 'Hello, no images here.');
  });

  it('returns plain string when image paths dont exist', () => {
    const result = parseImagesInMessage('Look at /nonexistent/image.png');
    assert.equal(result, 'Look at /nonexistent/image.png');
  });

  it('parses existing image path into content array', () => {
    const imgPath = join(tmpDir, 'test.png');
    writeFileSync(imgPath, Buffer.from([0x89, 0x50]));

    const result = parseImagesInMessage('Check this ' + imgPath);
    assert.ok(Array.isArray(result));
    const arr = result as { type: string }[];
    assert.ok(arr.some(p => p.type === 'image'));
    assert.ok(arr.some(p => p.type === 'text'));
  });

  it('adds default text block when only images', () => {
    const imgPath = join(tmpDir, 'only.png');
    writeFileSync(imgPath, Buffer.from([0x89, 0x50]));

    const result = parseImagesInMessage(imgPath);
    assert.ok(Array.isArray(result));
    const arr = result as { type: string; text?: string }[];
    const textBlocks = arr.filter(p => p.type === 'text');
    assert.ok(textBlocks.some(t => t.text === 'Describe this image.'));
  });

  it('handles multiple images in one message', () => {
    const img1 = join(tmpDir, 'a.png');
    const img2 = join(tmpDir, 'b.jpg');
    writeFileSync(img1, Buffer.from([0x89]));
    writeFileSync(img2, Buffer.from([0xff]));

    const result = parseImagesInMessage('First ' + img1 + ' and second ' + img2);
    assert.ok(Array.isArray(result));
    const arr = result as { type: string }[];
    const images = arr.filter(p => p.type === 'image');
    assert.equal(images.length, 2);
  });
});

describe('IMAGE_PATH_REGEX', () => {
  it('matches absolute image paths', () => {
    IMAGE_PATH_REGEX.lastIndex = 0;
    const match = IMAGE_PATH_REGEX.exec('Look at /tmp/screenshot.png please');
    assert.ok(match);
    assert.equal(match[1], '/tmp/screenshot.png');
  });

  it('matches at start of string', () => {
    IMAGE_PATH_REGEX.lastIndex = 0;
    const match = IMAGE_PATH_REGEX.exec('/home/user/photo.jpg');
    assert.ok(match);
  });

  it('does not match relative paths', () => {
    IMAGE_PATH_REGEX.lastIndex = 0;
    const match = IMAGE_PATH_REGEX.exec('relative/path/image.png');
    assert.equal(match, null);
  });
});

describe('Constants', () => {
  it('IMAGE_EXTENSIONS covers all supported types', () => {
    assert.equal(Object.keys(IMAGE_EXTENSIONS).length, 5);
  });

  it('IMAGE_TYPES_SET has all image MIME types', () => {
    assert.ok(IMAGE_TYPES_SET.has('image/png'));
    assert.ok(IMAGE_TYPES_SET.has('image/jpeg'));
    assert.ok(IMAGE_TYPES_SET.has('image/gif'));
    assert.ok(IMAGE_TYPES_SET.has('image/webp'));
  });

  it('MAX_TEXT_FILE_SIZE is 500KB', () => {
    assert.equal(MAX_TEXT_FILE_SIZE, 500_000);
  });
});
