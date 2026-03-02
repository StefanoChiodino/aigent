/**
 * Shared permission utilities for gatekeeper permission handlers.
 *
 * Provides:
 * - PendingRequests<T>: type-safe wrapper around pending map + auto-handled set + recently-resolved tracking
 * - PermCtx: context interface for permission handlers (access to client, logging, messaging)
 */

import type { createLogger } from './logger.js';

// --- Context interface ---

/**
 * Context passed to permission handlers — provides access to gatekeeper services
 * without coupling handlers to the gatekeeper's internal state.
 *
 * Follows the same pattern as ConfigWriteContext in gk-config-writes.ts.
 */
/** Classifier decision metadata — shared with web-bridge for broadcasting. */
export interface ClassifierDecision {
  tier: 1 | 2 | 3;
  action: 'allow' | 'block' | 'ask';
  reason: string;
}

export interface PermCtx {
  /** The AgentClient — used for sending responses back to the worker and emitting events. */
  client: { send(msg: unknown): void; emit(event: string, ...args: unknown[]): void } | null;
  log: ReturnType<typeof createLogger>;
  /** Inject a system message into the chat (visible to the user, not the agent). */
  injectSystemMessage(content: string): void;
  /** Broadcast updated permission settings to the web UI. */
  broadcastUpdatedPermissions(): void;
  /** Write to the audit log. */
  auditLog(entry: { type: string; detail: string; reason?: string; approved?: boolean }): void;
  /** Map of classifier decisions keyed by request ID — shared with web-bridge. */
  classifierDecisions: Map<string, ClassifierDecision>;
  /** Get recent conversation context for the classifier. */
  getRecentContext(): string | undefined;
}

// --- PendingRequests ---

/** Recently-resolved entry TTL in milliseconds. */
const RECENTLY_RESOLVED_TTL_MS = 5_000;

/**
 * Type-safe container for pending permission requests.
 *
 * Wraps three data structures that every permission type needs:
 * 1. `pending` — Map of requests awaiting user approval
 * 2. `autoHandled` — Set of IDs resolved before the web UI could show a modal
 * 3. `recentlyResolved` — Set of IDs resolved in the last 5s (prevents race condition
 *    where a user clicks "approve" after the request was already auto-resolved)
 */
export class PendingRequests<T> {
  readonly name: string;
  private pending = new Map<string, T>();
  private autoHandled = new Set<string>();
  private recentlyResolved = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  /** Add a request to the pending map. */
  add(id: string, data: T): void {
    this.pending.set(id, data);
  }

  /** Get a pending request by ID. */
  get(id: string): T | undefined {
    return this.pending.get(id);
  }

  /** Delete a pending request. */
  delete(id: string): boolean {
    return this.pending.delete(id);
  }

  /** Number of pending requests. */
  get size(): number {
    return this.pending.size;
  }

  /** Iterate over pending entries. */
  entries(): IterableIterator<[string, T]> {
    return this.pending.entries();
  }

  /** Get all pending IDs. */
  keys(): IterableIterator<string> {
    return this.pending.keys();
  }

  /**
   * When only one request is pending, return its ID.
   * Used for commands where the user can omit the ID.
   */
  getSingleId(): string | undefined {
    if (this.pending.size !== 1) return undefined;
    return this.pending.keys().next().value as string;
  }

  /** Mark an ID as auto-handled (resolved before web UI could show a modal). */
  markAutoHandled(id: string): void {
    this.autoHandled.add(id);
  }

  /** Check if an ID was auto-handled. */
  isAutoHandled(id: string): boolean {
    return this.autoHandled.has(id);
  }

  /**
   * Check and consume an auto-handled ID.
   * Returns true if the ID was auto-handled (and removes it from the set).
   * Used by web-bridge to skip forwarding already-resolved requests.
   */
  consumeAutoHandled(id: string): boolean {
    return this.autoHandled.delete(id);
  }

  /** Direct access to the autoHandled set — for backward compatibility with web-bridge. */
  get autoHandledIds(): Set<string> {
    return this.autoHandled;
  }

  /**
   * Mark an ID as recently resolved.
   * When a user clicks approve/deny after the request was already auto-resolved
   * by a settings flush, we can give a graceful "already resolved" response
   * instead of silently ignoring the click.
   */
  markResolved(id: string): void {
    this.recentlyResolved.set(id, Date.now());
  }

  /** Check if an ID was recently resolved (within the TTL). */
  isRecentlyResolved(id: string): boolean {
    const ts = this.recentlyResolved.get(id);
    if (ts === undefined) return false;
    if (Date.now() - ts > RECENTLY_RESOLVED_TTL_MS) {
      this.recentlyResolved.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Common flush pattern: re-check all pending requests against updated permissions.
   * For each entry, call `shouldAllow` — if it returns true, remove from pending,
   * call `resolve` with the entry, and collect the ID for dismissal broadcasting.
   *
   * Returns the list of dismissed IDs.
   */
  flush(
    shouldAllow: (id: string, data: T) => boolean,
    resolve: (id: string, data: T) => void,
  ): string[] {
    if (this.pending.size === 0) return [];
    const dismissed: string[] = [];
    for (const [id, data] of this.pending) {
      if (shouldAllow(id, data)) {
        this.pending.delete(id);
        this.markResolved(id);
        resolve(id, data);
        dismissed.push(id);
      }
    }
    return dismissed;
  }

  /**
   * Resolve a pending request: delete from map, mark resolved, and broadcast dismissal.
   * Returns the resolved data, or undefined if not found (already resolved).
   */
  resolve(id: string, _ctx: PermCtx): T | undefined {
    const data = this.pending.get(id);
    if (!data) return undefined;
    this.pending.delete(id);
    this.markResolved(id);
    return data;
  }

  /**
   * Broadcast `perm_dismissed` for the given IDs.
   * Call this after resolving one or more requests.
   */
  broadcastDismissed(ctx: PermCtx, ids: string[]): void {
    if (ids.length > 0 && ctx.client) {
      ctx.client.emit('perm_dismissed', ids);
    }
  }

  /** Periodic cleanup of expired recently-resolved entries. */
  cleanupExpired(): void {
    const now = Date.now();
    for (const [id, ts] of this.recentlyResolved) {
      if (now - ts > RECENTLY_RESOLVED_TTL_MS) {
        this.recentlyResolved.delete(id);
      }
    }
  }
}
