/**
 * Simple startup-time log rotation.
 *
 * If a log file exceeds maxBytes, rotate it by renaming:
 *   current → .1, .1 → .2, .2 → delete (keeping `keep` rotations).
 *
 * Designed to be called once at process startup — not during runtime.
 * Fire-and-forget: errors are silently swallowed.
 */

import { statSync, renameSync, unlinkSync } from 'node:fs';

export function rotateIfNeeded(
  path: string,
  maxBytes: number = 5 * 1024 * 1024,
  keep: number = 2,
): void {
  try {
    const stat = statSync(path);
    if (stat.size < maxBytes) return;

    // Shift existing rotations: delete oldest, then cascade down
    for (let i = keep; i >= 1; i--) {
      const src = i === 1 ? path : `${path}.${i - 1}`;
      const dst = `${path}.${i}`;
      try {
        if (i === keep) {
          try { unlinkSync(dst); } catch { /* doesn't exist */ }
        }
        renameSync(src, dst);
      } catch { /* source doesn't exist, skip */ }
    }
  } catch {
    // File doesn't exist or other error — nothing to rotate
  }
}
