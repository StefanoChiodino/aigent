/**
 * Safety utilities for tool execution.
 *
 * - Environment sanitization (strip API keys from child processes)
 * - Path validation (restrict writes to safe directories)
 * - URL validation (block SSRF to private/internal networks)
 * - Command safety checks (warn on destructive patterns)
 */

import { resolve } from 'node:path';

// --- Environment sanitization ---

/**
 * Keys to strip from child process environments.
 * These are secrets that tools and MCP servers should never see.
 */
const SENSITIVE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
];

/** Patterns to match against env key names (case-insensitive). */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
];

/**
 * Return a sanitized copy of process.env with secrets removed.
 * Keeps PATH, HOME, USER, LANG, TERM, and other safe variables.
 */
export function sanitizedEnv(): Record<string, string | undefined> {
  const env = { ...process.env };

  // Remove known sensitive keys
  for (const key of SENSITIVE_ENV_KEYS) {
    delete env[key];
  }

  // Remove keys matching sensitive patterns
  for (const key of Object.keys(env)) {
    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
      delete env[key];
    }
  }

  return env;
}

// --- Path validation ---

/**
 * Directories the agent is allowed to write to.
 *
 * In the gatekeeper architecture, /app is read-only by default.
 * Additional writable directories are added dynamically when the user
 * mounts folders via /mount (these mirror the host path inside the container).
 * The Docker mounts are the real security boundary — this is defense in depth.
 */
const WRITABLE_ROOTS = [
  '/workspace',     // Workspace (memory, config, sessions)
  '/project',       // User-mounted project folders (gatekeeper-controlled)
  '/tmp',           // Temp files
];

/**
 * Check if a file path is safe to write to.
 * Returns null if safe, or an error message if blocked.
 *
 * Note: this is defense-in-depth. The real write protection comes from
 * Docker mount modes (ro/rw) controlled by the gatekeeper. The kernel
 * enforces those regardless of what this function says.
 */
export function validateWritePath(filePath: string): string | null {
  const resolved = resolve(filePath);

  // Check if within a writable root
  const inWritableRoot = WRITABLE_ROOTS.some((root) => resolved.startsWith(root + '/') || resolved === root);
  if (!inWritableRoot) {
    return `Blocked: writes only allowed under ${WRITABLE_ROOTS.join(', ')}. Use request_mount to ask for access to other folders.`;
  }

  return null; // Safe
}

// --- URL validation (SSRF protection) ---

/**
 * Private/internal IP ranges that should not be accessed via fetch.
 */
const PRIVATE_RANGES = [
  // IPv4
  /^127\./,                          // Loopback
  /^10\./,                           // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // RFC 1918
  /^192\.168\./,                     // RFC 1918
  /^169\.254\./,                     // Link-local / cloud metadata
  /^0\./,                            // "This" network
  // IPv6 (common forms)
  /^::1$/,                           // Loopback
  /^fd[0-9a-f]{2}:/i,               // Unique local
  /^fe80:/i,                         // Link-local
];

/** Hostnames that should be blocked. */
const BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
];

/**
 * Check if a URL is safe to fetch.
 * Returns null if safe, or an error message if blocked.
 */
export function validateFetchUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  const hostname = parsed.hostname.toLowerCase();

  // Check blocked hostnames
  if (BLOCKED_HOSTS.includes(hostname)) {
    return `Blocked: cannot fetch ${hostname} (internal/metadata endpoint)`;
  }

  // Check private IP ranges
  for (const range of PRIVATE_RANGES) {
    if (range.test(hostname)) {
      return `Blocked: cannot fetch private IP ${hostname}`;
    }
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Blocked: only http/https URLs allowed (got ${parsed.protocol})`;
  }

  return null; // Safe
}

// --- Command safety ---

/** Patterns that indicate potentially destructive commands. */
const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, 'rm on root filesystem'],
  [/\bmkfs\b/, 'filesystem format'],
  [/\bdd\s+.*of=\/dev\//, 'raw device write'],
  [/:\(\)\s*\{.*\|.*&\s*\}\s*;/, 'fork bomb'],
  [/\bgit\s+push\s+.*--force/, 'force push'],
  [/\bcurl\b.*\|\s*(ba)?sh\b/, 'pipe URL to shell'],
  [/\bwget\b.*\|\s*(ba)?sh\b/, 'pipe URL to shell'],
  [/>\s*\/dev\/[sh]d[a-z]/, 'write to raw device'],
  [/\bchmod\s+777\s+\//, 'chmod 777 on root'],
  [/\bpasswd\b/, 'password change'],
];

/**
 * Check a command for dangerous patterns.
 * Returns null if no issues found, or a warning string.
 * This is advisory, not blocking — the agent can still run the command.
 */
export function checkCommandSafety(command: string): string | null {
  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Warning: ${description}`;
    }
  }
  return null;
}

// --- Read-only command validation (for background agents) ---

/** Patterns that indicate write/destructive operations. */
const READONLY_BLOCKLIST: [RegExp, string][] = [
  // File mutation
  [/\brm\b/, 'rm (file deletion)'],
  [/\bmv\b/, 'mv (file move/rename)'],
  [/\bcp\b/, 'cp (file copy)'],
  [/\bmkdir\b/, 'mkdir (directory creation)'],
  [/\brmdir\b/, 'rmdir (directory removal)'],
  [/\btouch\b/, 'touch (file creation)'],
  [/\bchmod\b/, 'chmod (permission change)'],
  [/\bchown\b/, 'chown (ownership change)'],
  [/\bln\b/, 'ln (link creation)'],
  [/\btee\b/, 'tee (write to file)'],
  [/\bdd\b/, 'dd (disk/file write)'],
  [/\btruncate\b/, 'truncate (file truncation)'],

  // In-place edits
  [/\bsed\s+(-[a-zA-Z]*i|--in-place)/, 'sed -i (in-place edit)'],
  [/\bperl\s+(-[a-zA-Z]*[pi]){2}/, 'perl -pi (in-place edit)'],

  // Git write operations
  [/\bgit\s+(add|commit|push|stash|checkout|reset|rebase|merge|cherry-pick|revert|clean|rm|mv)\b/, 'git write operation'],
  [/\bgit\s+branch\s+-[dD]\b/, 'git branch delete'],
  [/\bgit\s+tag\s+-d\b/, 'git tag delete'],

  // Package manager writes
  [/\b(npm|yarn|pnpm)\s+(install|uninstall|remove|add|update|publish|init|create)\b/, 'package manager write'],
  [/\bpip\s+(install|uninstall)\b/, 'pip write operation'],

  // Process/system mutation
  [/\bkill\b/, 'kill (process termination)'],
  [/\bpkill\b/, 'pkill (process termination)'],
  [/\bsudo\b/, 'sudo (privilege escalation)'],
  [/\bsu\s/, 'su (user switch)'],

  // Pipe to shell
  [/\bcurl\b.*\|\s*(ba)?sh/, 'pipe to shell'],
  [/\bwget\b.*\|\s*(ba)?sh/, 'pipe to shell'],
];

/**
 * Validate a command for read-only execution (background agents).
 * Returns null if safe, or an error message describing what was blocked.
 *
 * Strategy: blocklist of known destructive patterns + redirect detection.
 * Defense-in-depth — the system prompt also instructs read-only behavior.
 */
export function validateReadonlyCommand(command: string): string | null {
  // Check for output redirection on the full command
  if (/>{1,2}\s*[^&]/.test(command)) {
    return 'Blocked: output redirection — background agents are read-only';
  }

  // Split on shell operators and check each sub-command
  const subCommands = command.split(/\s*(?:\|{1,2}|;|&&)\s*/);

  for (const sub of subCommands) {
    for (const [pattern, description] of READONLY_BLOCKLIST) {
      if (pattern.test(sub)) {
        return `Blocked: ${description} — background agents are read-only`;
      }
    }
  }

  return null;
}
