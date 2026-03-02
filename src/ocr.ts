/**
 * OCR text extraction via system-installed tesseract CLI.
 *
 * Follows the external-tool pattern (like STT/TTS): check availability at
 * startup, degrade gracefully when not installed. Zero npm dependencies.
 *
 * Install: `apt install tesseract-ocr` (Debian/Ubuntu) or `brew install tesseract` (macOS)
 */

import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

let _tesseractAvailable: boolean | null = null;

/**
 * Check if the tesseract CLI is installed. Result is cached after the first call.
 */
export async function isTesseractAvailable(): Promise<boolean> {
  if (_tesseractAvailable !== null) return _tesseractAvailable;

  return new Promise((resolve) => {
    execFile('tesseract', ['--version'], { timeout: 5000 }, (err) => {
      _tesseractAvailable = !err;
      resolve(_tesseractAvailable);
    });
  });
}

/**
 * Extract text from a base64-encoded image using tesseract OCR.
 * Returns the extracted text, or null if tesseract is unavailable or fails.
 *
 * Typical latency: ~200-500ms per image.
 */
export async function extractTextFromImage(base64Data: string): Promise<string | null> {
  if (!(await isTesseractAvailable())) return null;

  const dir = '/tmp/aigent/ocr';
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const id = randomBytes(4).toString('hex');
  const inputPath = `${dir}/${id}.png`;

  try {
    // Write image to temp file (tesseract reads from file, not stdin for images)
    writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));

    const text = await new Promise<string>((resolve, reject) => {
      execFile('tesseract', [inputPath, 'stdout', '--psm', '3'], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(inputPath); } catch { /* ignore */ }
  }
}
