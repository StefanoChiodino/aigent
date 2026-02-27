/**
 * Shared settings.json read/write with serialization and audit logging.
 *
 * Both gatekeeper.tsx (sync writes) and web-bridge.ts (async writes) use this
 * module to prevent race conditions where concurrent read-modify-write cycles
 * can silently lose permission entries.
 *
 * All writes go through a single serialized queue.  Each write logs a diff
 * of any permission changes to /tmp/aigent-audit.log so data loss is traceable.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const log = createLogger('settings-file');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETTINGS_PATH = resolve(__dirname, '..', 'settings.json');

const envPath = process.env['AIGENT_SETTINGS_PATH'];
let settingsPath = envPath ? resolve(envPath) : DEFAULT_SETTINGS_PATH;

if (envPath) {
  log.info('Using custom settings path from AIGENT_SETTINGS_PATH', { path: settingsPath });
}

/** Override the settings path — for test isolation. */
export function _setSettingsPathForTest(path: string): void {
  settingsPath = path;
}

export function getSettingsPath(): string {
  return settingsPath;
}

// ---------------------------------------------------------------------------
// Read (always synchronous — the file is local and small)
// ---------------------------------------------------------------------------

export function readSettingsSync(): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) return {};
    const raw = readFileSync(settingsPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Serialized write queue
// ---------------------------------------------------------------------------

type WriteTask = {
  fn: (current: Record<string, unknown>) => Record<string, unknown>;
  caller: string;
  resolve: () => void;
  reject: (err: Error) => void;
};

const writeQueue: WriteTask[] = [];
let writing = false;

async function processQueue(): Promise<void> {
  if (writing) return; // another call is already draining
  writing = true;
  try {
    while (writeQueue.length > 0) {
      const task = writeQueue.shift()!;
      try {
        const current = readSettingsSync();
        const next = task.fn(current);
        logPermissionDiff(current, next, task.caller);
        const tmp = settingsPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
        renameSync(tmp, settingsPath);
        task.resolve();
      } catch (err) {
        log.error('Settings write failed', { caller: task.caller, error: String(err) });
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } finally {
    writing = false;
  }
}

/**
 * Enqueue a read-modify-write operation on settings.json.
 *
 * The `mutate` function receives the current settings object and must return
 * the new settings object to write.  Mutations are serialized — only one runs
 * at a time, so there is no risk of lost updates from concurrent callers.
 *
 * @param caller  A human-readable label for audit logging (e.g. 'web-bridge', 'gatekeeper:addToAlwaysAllow')
 * @param mutate  A function that receives current settings and returns the updated settings
 */
export function writeSettings(
  caller: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    writeQueue.push({ fn: mutate, caller, resolve, reject });
    void processQueue();
  });
}

/**
 * Synchronous write for gatekeeper functions.
 *
 * If the queue is empty (common case), performs an immediate sync write.
 * Otherwise enqueues and lets the async drain handle it.
 */
export function writeSettingsSync(
  caller: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (writeQueue.length === 0 && !writing) {
    // Fast path: immediate sync write
    writing = true;
    try {
      const current = readSettingsSync();
      const next = mutate(current);
      logPermissionDiff(current, next, caller);
      const tmp = settingsPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
      renameSync(tmp, settingsPath);
    } finally {
      writing = false;
    }
    return;
  }

  // Queue is busy — enqueue and drain.
  const p = writeSettings(caller, mutate);
  p.catch((err) => log.error('Queued sync write failed', { caller, error: String(err) }));
}

// ---------------------------------------------------------------------------
// Permission diff logging
// ---------------------------------------------------------------------------

function logPermissionDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  caller: string,
): void {
  const permKeys = ['exec_permissions', 'fetch_permissions', 'file_permissions'] as const;

  for (const key of permKeys) {
    const oldPerms = (before[key] ?? {}) as Record<string, unknown>;
    const newPerms = (after[key] ?? {}) as Record<string, unknown>;

    for (const field of ['alwaysAllow', 'alwaysClassify', 'deny'] as const) {
      const oldArr = Array.isArray(oldPerms[field]) ? oldPerms[field] as string[] : [];
      const newArr = Array.isArray(newPerms[field]) ? newPerms[field] as string[] : [];

      const oldSet = new Set(oldArr);
      const newSet = new Set(newArr);

      const added = newArr.filter(x => !oldSet.has(x));
      const removed = oldArr.filter(x => !newSet.has(x));

      if (added.length > 0 || removed.length > 0) {
        const isBulkRemoval = removed.length > 3 && added.length === 0;
        const logFn = isBulkRemoval ? log.warn.bind(log) : log.info.bind(log);
        logFn(`${key}.${field} changed [+${added.length} -${removed.length}]`, {
          caller,
          added: added.length > 0 ? added : undefined,
          removed: removed.length > 0 ? removed : undefined,
        });
        if (isBulkRemoval) {
          log.warn(`Bulk removal of ${removed.length} patterns from ${key}.${field} by ${caller} — this may indicate a bug`);
        }

        // Also write to audit log for forensic analysis
        try {
          const line = JSON.stringify({
            ts: Date.now(),
            type: 'settings_permission_change',
            key: `${key}.${field}`,
            caller,
            added: added.length > 0 ? added : undefined,
            removed: removed.length > 0 ? removed : undefined,
          }) + '\n';
          appendFileSync('/tmp/aigent-audit.log', line, 'utf-8');
        } catch {
          // Audit logging must never crash
        }
      }
    }
  }
}
