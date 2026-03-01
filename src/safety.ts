/**
 * Safety utilities for tool execution.
 *
 * - Environment sanitization (strip API keys from child processes)
 * - Path validation (restrict writes to safe directories)
 * - URL validation (block SSRF to private/internal networks)
 * - Command safety checks (warn on destructive patterns)
 * - Sensitive path detection (block access to credentials, system dirs)
 * - DNS rebinding protection (resolve hostname before fetch)
 */

import { homedir } from 'node:os';
import { promises as dnsPromises } from 'node:dns';
import { minimatch } from 'minimatch';

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

  // parsed.hostname returns bracketed form for IPv6: "[::1]", "[fe80::1]", etc.
  // Strip brackets before testing so PRIVATE_RANGES patterns work correctly.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

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
  // Block subshell constructs — static analysis cannot reliably inspect what runs inside them
  if (/\$\(/.test(command) || /`/.test(command)) {
    return 'Blocked: subshell constructs ($(...) or backticks) — background agents are read-only';
  }
  // Block explicit shell invocations that accept arbitrary command strings
  if (/\b(ba)?sh\s+-c\b/.test(command)) {
    return 'Blocked: shell -c invocation — background agents are read-only';
  }

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

// --- Fetch URL permissions ---

export interface FetchPermissions {
  alwaysAllow: string[]; // URL or hostname glob patterns
  deny: string[];
}

export type FetchPermissionLevel = 'allow' | 'prompt' | 'deny';

export const DEFAULT_FETCH_PERMISSIONS: FetchPermissions = {
  alwaysAllow: [],
  deny: [],      // SSRF still blocked separately by validateFetchUrl
};

/**
 * Match a URL against a permission pattern.
 * - Patterns containing "://" are matched against the full URL.
 * - Plain hostname patterns (e.g. "api.github.com", "*.anthropic.com") are
 *   matched against the URL's hostname only (backward compat).
 * - The catch-all "*" pattern matches any URL.
 */
export function matchFetchPattern(url: string, hostname: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.includes('://')) return minimatch(url, pattern);
  return minimatch(hostname, pattern);
}

/**
 * Check what permission level a fetch URL requires given user-configured permissions.
 * Patterns containing "://" match the full URL; plain patterns match the hostname.
 * Evaluation order: deny → alwaysAllow → prompt → default(prompt)
 */
export function checkFetchPermission(
  url: string,
  permissions: FetchPermissions,
): FetchPermissionLevel {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'deny';
  }
  const normalizedUrl = url.toLowerCase();
  for (const pattern of permissions.deny) {
    if (matchFetchPattern(normalizedUrl, hostname, pattern)) return 'deny';
  }
  for (const pattern of permissions.alwaysAllow) {
    if (matchFetchPattern(normalizedUrl, hostname, pattern)) return 'allow';
  }
  return 'prompt';
}

// --- Browser domain permissions ---

export interface BrowserPermissions {
  read: string[];    // domains where read actions (a11y, screenshot) auto-approve
  write: string[];   // domains where write actions (click, fill, navigate) auto-approve
  script: string[];  // domains where run_script with arbitrary JS auto-approves
  deny: string[];    // domains blocked from all browser automation
}

export type BrowserPermissionLevel = 'script' | 'write' | 'read' | 'deny' | 'prompt';

export const DEFAULT_BROWSER_PERMISSIONS: BrowserPermissions = {
  read: [],
  write: [],
  script: [],
  deny: [],
};

/** Recognized structured BrowserStep action keys (not arbitrary JS). */
const STRUCTURED_STEP_KEYS = new Set([
  'click', 'fill', 'navigate', 'scroll', 'wait', 'waitFor',
  'hover', 'pressKey', 'select', 'check', 'clear',
  'extractA11y', 'screenshot',
]);

/**
 * Classify the required permission tier for a browser action.
 * - Read actions: extract_a11y, screenshot, list_tabs, activate_tab
 * - Write actions: navigate, open_tab, close_tab, run_script with only structured steps
 * - Script actions: run_script with unrecognised step keys (arbitrary JS)
 */
export function classifyBrowserAction(
  action: string,
  steps?: unknown[],
): 'read' | 'write' | 'script' {
  if (action === 'extract_a11y' || action === 'screenshot' || action === 'list_tabs' || action === 'activate_tab') {
    return 'read';
  }
  if (action === 'navigate' || action === 'open_tab' || action === 'close_tab' || action === 'create_window' || action === 'close_agent_tabs') {
    return 'write';
  }
  // run_script — check if all steps are structured
  if (action === 'run_script' && Array.isArray(steps) && steps.length > 0) {
    for (const step of steps) {
      if (typeof step !== 'object' || step === null) return 'script';
      const keys = Object.keys(step as Record<string, unknown>);
      // Each step must have at least one recognized key and no unrecognized ones
      // (extra keys like 'by', 'value', 'timeout' are parameters to recognized actions)
      const PARAM_KEYS = new Set(['by', 'value', 'timeout', 'direction', 'amount', 'key']);
      const actionKeys = keys.filter(k => !PARAM_KEYS.has(k));
      if (actionKeys.length === 0) return 'script';
      for (const k of actionKeys) {
        if (!STRUCTURED_STEP_KEYS.has(k)) return 'script';
      }
    }
    return 'write';
  }
  // run_script with no steps or unknown action
  return 'script';
}

/**
 * Check browser domain permission level.
 * Evaluation order: deny → script → write → read → prompt.
 * Returns the granted tier for the domain, or 'deny'/'prompt'.
 */
export function checkBrowserPermission(
  url: string,
  permissions: BrowserPermissions,
): BrowserPermissionLevel {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'prompt';
  }
  const normalizedUrl = url.toLowerCase();
  for (const pattern of permissions.deny) {
    if (matchFetchPattern(normalizedUrl, hostname, pattern)) return 'deny';
  }
  for (const pattern of permissions.script) {
    if (matchFetchPattern(normalizedUrl, hostname, pattern)) return 'script';
  }
  for (const pattern of permissions.write) {
    if (matchFetchPattern(normalizedUrl, hostname, pattern)) return 'write';
  }
  for (const pattern of permissions.read) {
    if (matchFetchPattern(normalizedUrl, hostname, pattern)) return 'read';
  }
  return 'prompt';
}

/** Check if a granted tier is sufficient for the required tier. */
export function browserTierSufficient(
  granted: BrowserPermissionLevel,
  required: 'read' | 'write' | 'script',
): boolean {
  const TIER_RANK: Record<string, number> = { deny: -1, prompt: 0, read: 1, write: 2, script: 3 };
  return (TIER_RANK[granted] ?? 0) >= (TIER_RANK[required] ?? 0);
}

// --- File path permissions ---

export interface FilePermissions {
  readWrite: string[];  // paths where agent can both read and write
  readOnly: string[];   // paths where agent can read but not write
  deny: string[];       // paths blocked for both read and write
}

export type FilePermissionLevel = 'allow' | 'prompt' | 'deny';

export const DEFAULT_FILE_PERMISSIONS: FilePermissions = {
  readWrite: [],
  readOnly: [],
  deny: [
    '~/.ssh/**',
    '~/.gnupg/**',
    '~/.aws/**',
  ],
};

/**
 * Expand leading `~` or `~/` in a pattern to the user's home directory.
 */
function expandTilde(pattern: string): string {
  if (pattern === '~') return homedir();
  if (pattern.startsWith('~/')) return homedir() + pattern.slice(1);
  return pattern;
}

/**
 * Match a file path against a permission pattern.
 * - The catch-all "*" pattern matches any path.
 * - `~` at the start of a pattern is expanded to the home directory.
 * - Otherwise uses minimatch with `{ dot: true }` so dotfiles are matched.
 */
function matchFilePattern(path: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return minimatch(path, expandTilde(pattern), { dot: true });
}

/**
 * Check what permission level a file path requires given user-configured permissions.
 * Evaluation order: deny → readOnly (allow reads, deny writes) → readWrite → prompt
 */
export function checkFilePermission(
  path: string,
  permissions: FilePermissions,
  operation: 'read' | 'write',
): FilePermissionLevel {
  const normalizedPath = path.toLowerCase();
  for (const pattern of permissions.deny) {
    if (matchFilePattern(normalizedPath, pattern.toLowerCase())) return 'deny';
  }
  for (const pattern of permissions.readOnly) {
    if (matchFilePattern(normalizedPath, pattern.toLowerCase())) {
      return operation === 'read' ? 'allow' : 'deny';
    }
  }
  for (const pattern of permissions.readWrite) {
    if (matchFilePattern(normalizedPath, pattern.toLowerCase())) return 'allow';
  }
  return 'prompt';
}

// --- Exec command permissions ---

export interface ExecPermissions {
  alwaysAllow: string[];
  alwaysClassify: string[];
  deny: string[];
}

export type ExecPermissionLevel = 'allow' | 'prompt' | 'deny';

export const DEFAULT_EXEC_PERMISSIONS: ExecPermissions = {
  alwaysAllow: [
    // Git read-only
    'git log', 'git log *',
    'git status', 'git status *',
    'git diff', 'git diff *',
    'git show *',
    'git branch', 'git branch *',
    'git remote', 'git remote *',
    'git stash list',
    'git stash show *',
    'git tag', 'git tag *',
    'git rev-parse *',
    'git ls-files *',
    // Filesystem read-only
    'ls', 'ls *',
    'cat *',
    'head *', 'tail *',
    'grep *', 'rg *',
    'find *',
    'wc *',
    'file *',
    'stat *',
    // Text processing (read-only, no side effects)
    'jq', 'jq *',
    'sed *', 'awk *',
    'sort *', 'uniq *', 'tr *', 'cut *', 'column *',
    // HTTP clients: use the `fetch` tool instead (has SSRF protection + permission controls)
    // Python (npm run * and make * already allow arbitrary code execution)
    'python *', 'python3 *',
    // Shell builtins / system info
    'pwd', 'echo *', 'which *', 'env', 'whoami', 'id', 'hostname',
    'date', 'uname *', 'uptime',
    // Common dev tools
    'diff *', 'tree *', 'du *', 'df *',
    'realpath *', 'dirname *', 'basename *',
    'xargs *',
    // Node / build read-only
    'node --version', 'node -v',
    'npm --version', 'npm -v', 'npm list *', 'npm ls *',
    'tsc --version', 'tsc -v',
    'npx tsc --noEmit', 'npx tsc --noEmit *',
    // npm scripts / make
    'npm test', 'npm test *',
    'npm run', 'npm run *',
    'make', 'make *',
  ],
  alwaysClassify: [
    // Empty by default — if a user adds a pattern to alwaysAllow, we respect it.
    // Users can add patterns here (e.g. 'curl *') to force Tier 3 classification
    // even when a command matches alwaysAllow.
  ],
  deny: [
    'sudo *',
    'su *',
    'mkfs *',
    'dd if=* of=/dev/*', 'dd of=/dev/*',
    ':() { :|: & }; :',
    'rm -rf /*', 'rm -rf /',
    // HTTP clients — use the `fetch` tool instead (has SSRF protection + hostname allow/deny)
    'curl', 'curl *',
    'wget', 'wget *',
  ],
};

/**
 * Match a command string against a glob pattern.
 * Commands are not file paths, so * must match any character including '/' and spaces.
 * We convert the glob pattern to a regex rather than using minimatch (which is path-aware
 * and refuses to match '/' with '*').
 */
function matchesGlob(command: string, pattern: string): boolean {
  const cmd = command.trim();
  const pat = pattern.trim();
  // Exact match first (fast path, also handles patterns without wildcards)
  if (cmd === pat) return true;
  // Check if command starts with the pattern prefix (for "git log" matching "git log --oneline")
  // when the pattern has no wildcards
  if (!pat.includes('*') && !pat.includes('?') && !pat.includes('[')) {
    return cmd === pat || cmd.startsWith(pat + ' ');
  }
  // Convert glob to regex: escape special regex chars, then replace * and ? with regex equivalents.
  // * matches anything (including '/' and spaces); ? matches any single character.
  const regexSrc = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + regexSrc + '$').test(cmd);
}

// --- Pipeline parsing (for UI display) ---

export interface CommandSegment {
  /** The raw text of this pipeline segment. */
  raw: string;
  /** The operator that connects this segment to the next ('|', '||', '&&', ';'), or null for the last. */
  operator: '|' | '||' | '&&' | ';' | null;
  /** The executable name (first token), or null if it's a subshell/variable expression. */
  executable: string | null;
  /** True if this segment is or begins with a subshell construct ($(), backticks, bash -c). */
  isSubshell: boolean;
}

/**
 * Parse a shell command string into its pipeline segments for display in the UI.
 * Splits on |, ||, &&, ; and extracts the executable name from each segment.
 * Does not attempt full shell parsing — this is for display only.
 */
export function parseCommandPipeline(command: string): CommandSegment[] {
  // Walk the string character-by-character, respecting shell quoting (single quotes,
  // double quotes, backslash escapes) so that operators inside quoted strings are not
  // treated as pipeline separators.
  const segments: CommandSegment[] = [];
  const parts: Array<{ text: string; operator: CommandSegment['operator'] }> = [];

  let i = 0;
  let segStart = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < command.length) {
    const ch = command[i]!;

    // Backslash escape — skip next character (works in double quotes and unquoted)
    if (ch === '\\' && !inSingle) {
      i += 2;
      continue;
    }

    // Toggle quote state
    if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }

    // Only match operators when outside quotes
    if (!inSingle && !inDouble) {
      let op: CommandSegment['operator'] = null;
      if (command[i] === '|' && command[i + 1] === '|') { op = '||'; }
      else if (command[i] === '&' && command[i + 1] === '&') { op = '&&'; }
      else if (command[i] === '|') { op = '|'; }
      else if (command[i] === ';') { op = ';'; }

      if (op) {
        const text = command.slice(segStart, i).trim();
        if (text) parts.push({ text, operator: op });
        i += op.length;
        segStart = i;
        continue;
      }
    }

    i++;
  }
  // Last segment (no trailing operator)
  const tail = command.slice(segStart).trim();
  if (tail) parts.push({ text: tail, operator: null });

  for (const { text, operator } of parts) {
    const isSubshell =
      /\$\(/.test(text) || /`/.test(text) || /\b(ba)?sh\s+-c\b/.test(text);

    // Extract executable: first token, ignoring leading env var assignments (FOO=bar cmd)
    let executable: string | null = null;
    const tokens = text.split(/\s+/);
    for (const tok of tokens) {
      if (!tok) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // env var assignment
      if (tok.startsWith('$')) { executable = null; break; }
      executable = tok.split('/').pop() ?? tok; // basename only
      break;
    }

    segments.push({ raw: text, operator, executable, isSubshell });
  }

  return segments.length > 0 ? segments : [{ raw: command, operator: null, executable: null, isSubshell: false }];
}

/** Tier 1: Hard deny patterns that can never be overridden. */
const TIER1_DENY_PATTERNS: [RegExp | ((cmd: string) => boolean), string][] = [
  // Shell injection constructs — make static analysis impossible
  [/\$\(/, 'subshell construct $()'],
  [/`/, 'backtick subshell'],
  [/\beval\b/, 'eval command'],
  [/\bsource\b/, 'source command'],
  [/\b(ba)?sh\s+-c\b/, 'shell -c invocation'],

  // Credential paths
  [(cmd: string) => /~\/\.ssh\b|\/\.ssh\//.test(cmd), 'SSH key access'],
  [(cmd: string) => /~\/\.gnupg\b|\/\.gnupg\//.test(cmd), 'GPG key access'],
  [(cmd: string) => /~\/\.aws\b|\/\.aws\//.test(cmd), 'AWS credential access'],

  // System destruction
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, 'rm on root filesystem'],
  [/\bmkfs\b/, 'filesystem format'],
  [/\bdd\s+.*of=\/dev\//, 'raw device write'],
  [/:\(\)\s*\{.*\|.*&\s*\}\s*;/, 'fork bomb'],

  // Privilege escalation
  [/\bsudo\b/, 'privilege escalation (sudo)'],
  [/\bsu\s/, 'privilege escalation (su)'],

  // Exfiltration
  [/\bcurl\b.*\|\s*(ba)?sh\b/, 'pipe URL to shell'],
  [/\bwget\b.*\|\s*(ba)?sh\b/, 'pipe URL to shell'],
];

/**
 * Tier 1 static deny check. Returns the reason string if blocked, null if pass.
 * Runs before Tier 2 (settings.json) and Tier 3 (Haiku classifier).
 * Catches injection constructs that make glob-based pattern matching unreliable.
 */
export function checkTier1Deny(command: string): string | null {
  for (const [check, reason] of TIER1_DENY_PATTERNS) {
    if (typeof check === 'function' ? check(command) : check.test(command)) {
      return reason;
    }
  }
  return null;
}

/**
 * Check what permission level a command requires given user-configured permissions.
 * Evaluation order: deny → alwaysAllow → default(prompt)
 */
export function checkExecPermission(
  command: string,
  permissions: ExecPermissions,
): ExecPermissionLevel {
  for (const pattern of permissions.deny) {
    if (matchesGlob(command, pattern)) return 'deny';
  }
  for (const pattern of permissions.alwaysAllow) {
    if (matchesGlob(command, pattern)) return 'allow';
  }
  return 'prompt';
}

/**
 * Check if a command should be forced through the Tier 3 classifier,
 * even if it matched a Tier 2 alwaysAllow pattern.
 *
 * Use this for commands like `curl`, `python`, `node -e` that are
 * context-dependent — sometimes safe, sometimes dangerous.
 */
export function shouldForceClassify(command: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesGlob(command, pattern)) return true;
  }
  return false;
}

// --- Sensitive path detection ---

/**
 * Paths that are always blocked — no user override.
 * Covers credentials, kernel interfaces, and hardware devices.
 */
const SENSITIVE_PATH_HARD_DENY: ((abs: string) => boolean)[] = [
  // Credential dirs
  (p) => p.startsWith(homedir() + '/.ssh'),
  (p) => p.startsWith(homedir() + '/.gnupg'),
  (p) => p.startsWith(homedir() + '/.aws'),
  // Kernel / hardware / boot
  (p) => p.startsWith('/proc'),
  (p) => p.startsWith('/sys'),
  (p) => p.startsWith('/dev'),
  (p) => p.startsWith('/boot'),
  // Root's home
  (p) => p.startsWith('/root'),
  // Credential file extensions (anywhere on the system)
  (p) => /\.(key|pem|p12|pfx|crt|cer|ppk)$/i.test(p),
];

/**
 * Paths that require user approval (prompt) before access.
 * Agent must provide a reason; user approves or rejects.
 */
const SENSITIVE_PATH_PROMPT: ((abs: string, home: string) => boolean)[] = [
  // Anything in home dir but outside the project
  (p, home) => p.startsWith(home) && !p.startsWith(home + '/.'),  // broad home access
  // System config and runtime dirs
  (p) => p.startsWith('/etc'),
  (p) => p.startsWith('/usr'),
  (p) => p.startsWith('/var'),
  (p) => p.startsWith('/tmp'),
];

export type SensitivePathLevel = 'deny' | 'prompt' | null;

/**
 * Check if a (resolved, absolute) file path is sensitive.
 * Returns:
 *   'deny'   — hard block, never allowed
 *   'prompt' — requires user approval
 *   null     — not sensitive, proceed normally
 */
export function checkSensitivePath(absPath: string): SensitivePathLevel {
  const home = homedir();
  for (const check of SENSITIVE_PATH_HARD_DENY) {
    if (check(absPath)) return 'deny';
  }
  for (const check of SENSITIVE_PATH_PROMPT) {
    if (check(absPath, home)) return 'prompt';
  }
  return null;
}

// --- DNS rebinding SSRF protection ---

/** Result of DNS validation — either an error or the resolved IPs for curl pinning. */
export interface DnsValidationResult {
  error?: string;
  resolvedIps?: string[];
  hostname?: string;
}

/**
 * Async extension of validateFetchUrl that also resolves the hostname's DNS
 * to catch DNS rebinding attacks (hostname passes static check but resolves to
 * a private/internal IP at connection time).
 *
 * Returns resolved IPs on success (for --resolve pinning) or an error string.
 */
export async function validateFetchUrlDns(url: string): Promise<DnsValidationResult> {
  // Static checks first (protocol, private IP literals, blocked hostnames)
  const staticErr = validateFetchUrl(url);
  if (staticErr) return { error: staticErr };

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { error: 'Invalid URL' };
  }

  // Skip DNS lookup for IP literals — already checked by PRIVATE_RANGES regexes above
  if (/^[\d.]+$/.test(hostname) || /^[0-9a-fA-F:]+$/.test(hostname)) {
    return { resolvedIps: [], hostname };
  }

  try {
    // Resolve both A and AAAA records
    const results = await Promise.allSettled([
      dnsPromises.resolve4(hostname),
      dnsPromises.resolve6(hostname),
    ]);
    const addrs: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') addrs.push(...r.value);
    }
    for (const addr of addrs) {
      for (const range of PRIVATE_RANGES) {
        if (range.test(addr)) {
          return { error: `Blocked: ${hostname} resolves to private/internal IP ${addr} (DNS rebinding protection)` };
        }
      }
    }
    // Only pin IPv4 addresses — IPv6 pinning via --resolve breaks curl's
    // happy-eyeballs fallback in environments without IPv6 connectivity,
    // causing "Couldn't connect to server" errors for all fetches.
    // We still validate AAAA records above for the private-IP security check.
    const ipv4Only = addrs.filter(a => !a.includes(':'));
    return { resolvedIps: ipv4Only, hostname };
  } catch {
    // DNS resolution failed — let the fetch fail at the network layer naturally
    return { resolvedIps: [], hostname };
  }
}

// --- MCP tool permissions ---

export interface MCPPermissions {
  servers: Record<string, {
    default: 'allow' | 'deny' | 'prompt';
    tools?: Record<string, 'allow' | 'deny' | 'prompt'>;
  }>;
}

export type MCPPermissionLevel = 'allow' | 'prompt' | 'deny';

export const DEFAULT_MCP_PERMISSIONS: MCPPermissions = { servers: {} };

/**
 * Check what permission level an MCP tool call requires.
 * Evaluation order: per-tool override → server default → global default (prompt).
 */
export function checkMCPPermission(
  server: string,
  tool: string,
  permissions: MCPPermissions,
): MCPPermissionLevel {
  const serverPerms = permissions.servers[server];
  if (!serverPerms) return 'prompt';
  const toolLevel = serverPerms.tools?.[tool];
  if (toolLevel) return toolLevel;
  return serverPerms.default ?? 'prompt';
}
