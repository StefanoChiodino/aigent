/**
 * Browser extension safety utilities — destructive action heuristics and SSRF validation.
 *
 * Used by the gatekeeper to flag potentially irreversible browser actions
 * (submit, delete, purchase, etc.) and to block navigations to private IPs.
 */

import { validateFetchUrl } from './safety.js';

export const DESTRUCTIVE_PATTERNS = [
  /\bsubmit\b/i, /\bsend\b/i, /\bdelete\b/i, /\bremove\b/i,
  /\bpurchase\b/i, /\bbuy\b/i, /\bconfirm\b/i, /\bpay\b/i,
  /\bpublish\b/i, /\bpost\b/i, /\bdeploy\b/i,
];

/** Check if a string matches any destructive pattern. Returns the first match or null. */
export function matchDestructive(text: string): string | null {
  for (const pat of DESTRUCTIVE_PATTERNS) {
    const m = pat.exec(text);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/**
 * Scan browser action steps for destructive click targets.
 * Returns a list of matched destructive keywords found in the steps.
 */
export function detectDestructiveSteps(action: string, steps?: unknown[], url?: string): string[] {
  const matches: string[] = [];

  // Check navigate / open_tab URLs for destructive path segments
  if (url && (action === 'navigate' || action === 'open_tab')) {
    try {
      const parsed = new URL(url);
      const m = matchDestructive(parsed.pathname);
      if (m) matches.push(`navigate → "${m}" in URL path`);
    } catch { /* invalid URL — will be caught by SSRF check */ }
  }

  if (!steps || !Array.isArray(steps)) return matches;

  for (const step of steps) {
    const s = step as Record<string, unknown>;

    // Check click steps
    if ('click' in s && typeof s['click'] === 'string') {
      const selector = s['click'];
      const by = (s['by'] as string) ?? 'css';

      if (by === 'text' || by === 'aria') {
        // The selector IS the visible label / aria-label
        const m = matchDestructive(selector);
        if (m) matches.push(`click "${selector}" (${m})`);
      } else {
        // CSS selector — check for embedded labels and submit types
        const m = matchDestructive(selector);
        if (m) matches.push(`click ${selector} (${m})`);
        if (/\[type=["']?submit["']?\]/i.test(selector)) {
          matches.push(`click ${selector} (submit)`);
        }
      }
    }

    // Check navigate steps within run_script
    if ('navigate' in s && typeof s['navigate'] === 'string') {
      try {
        const parsed = new URL(s['navigate'] as string);
        const m = matchDestructive(parsed.pathname);
        if (m) matches.push(`navigate → "${m}" in URL path`);
      } catch { /* ignore invalid */ }
    }
  }

  return matches;
}

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
