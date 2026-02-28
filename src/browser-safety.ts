/**
 * Browser extension safety utilities — SSRF validation for browser navigations.
 *
 * Used by the gatekeeper to block navigations to private IPs / metadata endpoints.
 */

import { validateFetchUrl } from './safety.js';

/* ── Destructive-action detection ────────────────────────────────────────── */

/** Keywords that indicate a destructive / irreversible browser action. */
const DESTRUCTIVE_KEYWORDS = [
  'delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'wipe',
  'submit', 'purchase', 'buy', 'pay', 'checkout', 'order', 'confirm',
  'deploy', 'publish', 'release', 'post', 'send', 'transfer',
  'unsubscribe', 'deactivate', 'disable', 'revoke', 'terminate',
];

const DESTRUCTIVE_RE = new RegExp(
  `\\b(${DESTRUCTIVE_KEYWORDS.join('|')})\\b`,
  'i',
);

/** Check a single string for a destructive keyword. Returns the keyword or null. */
export function matchDestructive(text: string): string | null {
  const m = DESTRUCTIVE_RE.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Scan a browser action (steps + url) for destructive signals.
 * Returns an array of human-readable match descriptions (empty = safe).
 */
export function detectDestructiveSteps(
  action: string,
  steps?: unknown[],
  url?: string,
): string[] {
  const matches: string[] = [];

  // Non-write actions are inherently safe
  const writeActions = new Set(['run_script', 'navigate', 'open_tab', 'close_tab']);
  if (!writeActions.has(action)) return matches;

  // Check top-level URL
  if (url) {
    const kw = matchDestructive(url);
    if (kw) matches.push(`url contains "${kw}"`);
  }

  // Check individual steps
  if (steps && Array.isArray(steps)) {
    for (const step of steps) {
      const s = step as Record<string, unknown>;

      // Click steps — check the selector / label text
      if ('click' in s && typeof s['click'] === 'string') {
        const target = s['click'] as string;
        const kw = matchDestructive(target);
        if (kw) {
          matches.push(`click target contains "${kw}"`);
        }
        // Also catch [type=submit] in CSS selectors
        if (/\[type\s*=\s*['"]?submit['"]?\]/i.test(target)) {
          matches.push(`click target contains "submit" (type=submit)`);
        }
      }

      // Navigate steps within run_script
      if ('navigate' in s && typeof s['navigate'] === 'string') {
        const kw = matchDestructive(s['navigate'] as string);
        if (kw) matches.push(`navigate url contains "${kw}"`);
      }
    }
  }

  return matches;
}

/* ── SSRF / URL validation ───────────────────────────────────────────────── */

/**
 * Validate all URLs in a browser action against SSRF rules.
 * Returns null if safe, or an error message if blocked.
 */
export function validateBrowserUrls(action: string, steps?: unknown[], url?: string): string | null {
  // Check top-level URL (navigate / open_tab)
  if (url && (action === 'navigate' || action === 'open_tab')) {
    const err = validateFetchUrl(url);
    if (err) return err;
  }

  // Check navigate steps within run_script
  if (steps && Array.isArray(steps)) {
    for (const step of steps) {
      const s = step as Record<string, unknown>;
      if ('navigate' in s && typeof s['navigate'] === 'string') {
        const err = validateFetchUrl(s['navigate'] as string);
        if (err) return `Step navigate blocked: ${err}`;
      }
    }
  }

  return null;
}
