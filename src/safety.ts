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

/** Directories the agent is allowed to write to. */
const WRITABLE_ROOTS = [
  '/workspace',     // Workspace (memory, config, sessions)
  '/app/src',       // Source code (self-authoring)
  '/tmp',           // Temp files
];

/** Files/paths that should never be written to, even within writable roots. */
const BLOCKED_PATHS = [
  '/app/entrypoint.sh',
  '/app/package.json',
  '/app/package-lock.json',
  '/app/tsconfig.json',
  '/app/Dockerfile',
  '/app/docker-compose.yml',
  '/app/Makefile',
  '/app/.env',
];

/**
 * Check if a file path is safe to write to.
 * Returns null if safe, or an error message if blocked.
 */
export function validateWritePath(filePath: string): string | null {
  const resolved = resolve(filePath);

  // Check blocked paths first
  for (const blocked of BLOCKED_PATHS) {
    if (resolved === blocked || resolved.startsWith(blocked + '/')) {
      return `Blocked: cannot write to ${blocked} (infrastructure file)`;
    }
  }

  // Check if within a writable root
  const inWritableRoot = WRITABLE_ROOTS.some((root) => resolved.startsWith(root + '/') || resolved === root);
  if (!inWritableRoot) {
    return `Blocked: writes only allowed under ${WRITABLE_ROOTS.join(', ')}`;
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
