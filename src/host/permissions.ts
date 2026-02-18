/**
 * Permission store — loads/saves permissions, handles grant checks and user prompts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { CapabilityName, GrantLevel, PermissionEntry } from './protocol.js';

const DEFAULT_TIMED_TTL = 300; // 5 minutes

/** Default permissions — everything requires a prompt. */
const DEFAULTS: Record<string, PermissionEntry> = {
  'clipboard.read': { grant: 'prompt' },
  'clipboard.write': { grant: 'prompt' },
  'screen.capture': { grant: 'prompt' },
  'screen.list': { grant: 'prompt' },
  'audio.play': { grant: 'prompt' },
  'audio.record': { grant: 'prompt' },
  'notify': { grant: 'prompt' },
  'open': { grant: 'prompt' },
  'fs.read': { grant: 'deny' },
  'fs.write': { grant: 'deny' },
};

export class PermissionStore {
  private permissions: Map<CapabilityName, PermissionEntry> = new Map();
  private sessionGrants: Set<CapabilityName> = new Set();
  private timedGrants: Map<CapabilityName, number> = new Map(); // capability → expires timestamp
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, PermissionEntry>;
      for (const [key, entry] of Object.entries(parsed)) {
        this.permissions.set(key as CapabilityName, entry);
      }
    } catch {
      // No config or invalid — use defaults
    }

    // Fill in any missing capabilities with defaults
    for (const [key, entry] of Object.entries(DEFAULTS)) {
      if (!this.permissions.has(key as CapabilityName)) {
        this.permissions.set(key as CapabilityName, { ...entry });
      }
    }
  }

  save(): void {
    const obj: Record<string, PermissionEntry> = {};
    for (const [key, entry] of this.permissions) {
      // Only persist allow and deny — session/timed/prompt don't need saving
      // (session/timed are ephemeral, prompt is the default)
      obj[key] = { grant: entry.grant, ...(entry.ttl ? { ttl: entry.ttl } : {}) };
    }
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(obj, null, 2) + '\n');
  }

  getGrant(capability: CapabilityName): GrantLevel {
    return this.permissions.get(capability)?.grant ?? 'deny';
  }

  setGrant(capability: CapabilityName, grant: GrantLevel): void {
    const entry = this.permissions.get(capability) ?? { grant: 'prompt' };
    entry.grant = grant;
    this.permissions.set(capability, entry);
    if (grant === 'allow' || grant === 'deny') {
      this.save();
    }
  }

  /** Apply CLI overrides (--allow, --deny flags). */
  applyOverrides(allow: CapabilityName[], deny: CapabilityName[]): void {
    for (const cap of allow) this.setGrant(cap, 'allow');
    for (const cap of deny) this.setGrant(cap, 'deny');
  }

  /**
   * Check if a capability is allowed right now.
   * Returns true if allowed, false if denied, null if needs prompting.
   */
  check(capability: CapabilityName): boolean | null {
    const grant = this.getGrant(capability);

    switch (grant) {
      case 'allow':
        return true;
      case 'deny':
        return false;
      case 'session':
        return this.sessionGrants.has(capability);
      case 'timed': {
        const expires = this.timedGrants.get(capability);
        if (expires && Date.now() < expires) return true;
        // Expired — needs re-prompting
        this.timedGrants.delete(capability);
        return null;
      }
      case 'prompt':
        return null;
      default:
        return false;
    }
  }

  /** Record a session grant (lasts until daemon restarts). */
  grantSession(capability: CapabilityName): void {
    this.sessionGrants.add(capability);
  }

  /** Record a timed grant. */
  grantTimed(capability: CapabilityName): void {
    const ttl = this.permissions.get(capability)?.ttl ?? DEFAULT_TIMED_TTL;
    this.timedGrants.set(capability, Date.now() + ttl * 1000);
  }

  /** Prompt the user for permission. Returns the user's choice. */
  async prompt(capability: CapabilityName, reason?: string): Promise<'allow' | 'session' | 'deny'> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });

    return new Promise<'allow' | 'session' | 'deny'>((resolve) => {
      process.stderr.write(`\n[aigent-host] Agent requests: ${capability}\n`);
      if (reason) {
        process.stderr.write(`  Reason: "${reason}"\n`);
      }
      process.stderr.write('  Allow? [y]es (this time) / [s]ession / [a]lways / [n]o > ');

      const timeout = setTimeout(() => {
        rl.close();
        process.stderr.write('(timeout — denied)\n');
        resolve('deny');
      }, 30_000);

      rl.once('line', (answer) => {
        clearTimeout(timeout);
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === 'y' || a === 'yes') {
          resolve('allow'); // one-time allow (not persisted)
        } else if (a === 's' || a === 'session') {
          resolve('session');
        } else if (a === 'a' || a === 'always') {
          // Persist as 'allow'
          this.setGrant(capability, 'allow');
          resolve('allow');
        } else {
          resolve('deny');
        }
      });
    });
  }

  /** Get all permissions as a summary (for the capabilities event). */
  getAll(): Record<CapabilityName, GrantLevel> {
    const result: Record<string, GrantLevel> = {};
    for (const [key, entry] of this.permissions) {
      result[key] = entry.grant;
    }
    return result as Record<CapabilityName, GrantLevel>;
  }
}
