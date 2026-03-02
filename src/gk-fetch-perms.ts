/**
 * Fetch URL and fetch size permission handlers.
 *
 * Extracted from gatekeeper.tsx — handles fetch URL approval (allow/deny/prompt)
 * and large fetch size approval.
 */

import { checkFetchPermission, DEFAULT_FETCH_PERMISSIONS, type FetchPermissions } from './safety.js';
import { readSettingsSync, writeSettingsSync } from './settings-file.js';
import { PendingRequests, type PermCtx } from './gk-perm-utils.js';

// --- State ---

interface PendingFetch {
  url: string;
  method?: string;
}

interface PendingFetchSize {
  url: string;
  requestedBytes: number;
  defaultBytes: number;
}

export const pendingFetchApprovals = new PendingRequests<PendingFetch>('fetch');
export const pendingFetchSizeApprovals = new PendingRequests<PendingFetchSize>('fetchSize');

// --- Settings readers ---

export function readFetchPermissions(): FetchPermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['fetch_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_FETCH_PERMISSIONS;
    const p = perms as Partial<FetchPermissions>;
    return {
      alwaysAllow: Array.isArray(p.alwaysAllow)
        ? p.alwaysAllow
        : DEFAULT_FETCH_PERMISSIONS.alwaysAllow,
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_FETCH_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_FETCH_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_FETCH_PERMISSIONS;
  }
}

// --- Settings writers ---

function addToFetchAlwaysAllow(ctx: PermCtx, pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToFetchAlwaysAllow', (settings) => {
      const perms = (settings['fetch_permissions'] as Partial<FetchPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.alwaysAllow) ? [...perms.alwaysAllow] : [...DEFAULT_FETCH_PERMISSIONS.alwaysAllow];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, fetch_permissions: { ...DEFAULT_FETCH_PERMISSIONS, ...perms, alwaysAllow: current } };
    });
    ctx.log.info('Added pattern to fetch always-allow', { pattern });
    ctx.broadcastUpdatedPermissions();
    flushPendingFetchApprovals(ctx);
  } catch (err) {
    ctx.log.error('Failed to update fetch permissions', { error: String(err) });
  }
}

// --- Flush ---

/** Re-check pending fetch approvals against updated permissions and auto-resolve matches. */
export function flushPendingFetchApprovals(ctx: PermCtx): void {
  const yolo = readSettingsSync()['fetch_perm_yolo'] === true;
  const permissions = readFetchPermissions();
  const dismissed = pendingFetchApprovals.flush(
    (_id, pending) => yolo || checkFetchPermission(pending.url, permissions) === 'allow',
    (id, pending) => {
      const reason = yolo ? 'YOLO mode' : 'updated permission policy';
      ctx.log.info('Flush: auto-approving pending fetch', { id, url: pending.url, reason });
      ctx.client!.send({ type: 'fetch_response', id, ok: true, message: `Allowed by ${reason}` });
    },
  );
  pendingFetchApprovals.broadcastDismissed(ctx, dismissed);
}

// --- Fetch request handler ---

/** Handle a fetch URL request from the agent. */
export function handleAgentFetchRequest(ctx: PermCtx, id: string, url: string, method?: string): void {
  // --- YOLO mode: auto-approve all fetch requests ---
  if (readSettingsSync()['fetch_perm_yolo'] === true) {
    ctx.log.info('Fetch auto-allowed (YOLO mode)', { id, url });
    ctx.auditLog({ type: 'fetch_yolo_allow', detail: url });
    pendingFetchApprovals.markAutoHandled(id);
    ctx.client!.send({ type: 'fetch_response', id, ok: true, message: 'Allowed (YOLO mode)' });
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  const permissions = readFetchPermissions();
  const level = checkFetchPermission(url, permissions);

  if (level === 'allow') {
    ctx.log.info('Fetch auto-allowed', { id, url });
    pendingFetchApprovals.markAutoHandled(id);
    ctx.client!.send({ type: 'fetch_response', id, ok: true, message: 'Allowed by permission policy' });
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  if (level === 'deny') {
    ctx.log.info('Fetch auto-denied', { id, url });
    pendingFetchApprovals.markAutoHandled(id);
    ctx.client!.send({ type: 'fetch_response', id, ok: false, message: 'Denied by permission policy' });
    ctx.injectSystemMessage(`[fetch] Blocked by deny policy: ${url}`);
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  // 'prompt' — store and forward to web UI for user approval
  pendingFetchApprovals.add(id, { url, ...(method !== undefined ? { method } : {}) });
  ctx.log.info('Fetch approval requested', { id, url, method });

  ctx.injectSystemMessage(
    `Agent wants to fetch: ${method ?? 'GET'} ${url}\n` +
    `  Reply: /approve-fetch ${id} or /deny-fetch ${id}\n` +
    `  To always allow this URL: /approve-fetch ${id} --always\n` +
    `  To always allow this domain: /approve-fetch ${id} --always-domain`
  );
}

// --- Fetch approve/reject ---

/** Handle /approve-fetch and /deny-fetch commands. Returns true if command was handled. */
export async function handleFetchApproveReject(ctx: PermCtx, input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve-fetch') {
    let id = parts[1];
    if (!id && pendingFetchApprovals.size === 1) {
      id = pendingFetchApprovals.getSingleId();
    }
    if (!id) {
      ctx.injectSystemMessage(pendingFetchApprovals.size === 0
        ? 'No pending fetch requests.'
        : `Multiple pending — specify ID: ${[...pendingFetchApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingFetchApprovals.resolve(id, ctx);
    if (!pending) {
      if (pendingFetchApprovals.isRecentlyResolved(id)) {
        ctx.injectSystemMessage('Already resolved (auto-approved by updated permissions).');
        pendingFetchApprovals.broadcastDismissed(ctx, [id]);
      }
      return true;
    }

    const alwaysAllow = parts.includes('--always') || parts.includes('--always-domain');
    const alwaysDomain = parts.includes('--always-domain');

    if (alwaysDomain) {
      let hostname = pending.url;
      try { hostname = new URL(pending.url).hostname; } catch { /* keep raw */ }
      addToFetchAlwaysAllow(ctx, hostname);
      ctx.injectSystemMessage(`Approved and domain added to always-allow: ${hostname}`);
    } else if (alwaysAllow) {
      addToFetchAlwaysAllow(ctx, pending.url);
      ctx.injectSystemMessage(`Approved and URL added to always-allow: ${pending.url}`);
    } else {
      ctx.injectSystemMessage(`Approved (once): ${pending.url}`);
    }

    ctx.auditLog({ type: 'fetch_user_approve', detail: pending.url, approved: true });
    ctx.client!.send({ type: 'fetch_response', id, ok: true, alwaysAllow, message: 'Approved by user' });
    pendingFetchApprovals.broadcastDismissed(ctx, [id]);
    return true;
  }

  if (cmd === '/deny-fetch') {
    let id = parts[1];
    if (!id && pendingFetchApprovals.size === 1) {
      id = pendingFetchApprovals.getSingleId();
    }
    if (!id) {
      ctx.injectSystemMessage(pendingFetchApprovals.size === 0
        ? 'No pending fetch requests.'
        : `Multiple pending — specify ID: ${[...pendingFetchApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingFetchApprovals.resolve(id, ctx);
    if (!pending) {
      if (pendingFetchApprovals.isRecentlyResolved(id)) {
        ctx.injectSystemMessage('Already resolved (auto-approved by updated permissions).');
        pendingFetchApprovals.broadcastDismissed(ctx, [id]);
      }
      return true;
    }

    ctx.injectSystemMessage(`Denied fetch: ${pending.url}`);
    ctx.auditLog({ type: 'fetch_user_deny', detail: pending.url, approved: false });
    ctx.client!.send({ type: 'fetch_response', id, ok: false, message: 'Denied by user' });
    pendingFetchApprovals.broadcastDismissed(ctx, [id]);
    return true;
  }

  return false;
}

// --- Fetch size request handler ---

/** Handle a large-fetch size approval request from the agent. */
export function handleAgentFetchSizeRequest(ctx: PermCtx, id: string, url: string, requestedBytes: number, defaultBytes: number): void {
  pendingFetchSizeApprovals.add(id, { url, requestedBytes, defaultBytes });
  const mb = (requestedBytes / (1024 * 1024)).toFixed(1);
  const defaultMb = (defaultBytes / (1024 * 1024)).toFixed(0);
  ctx.log.info('Fetch size approval requested', { id, url, requestedBytes });
  ctx.injectSystemMessage(
    `Agent wants to fetch up to ${mb} MB from:\n` +
    `  ${url}\n` +
    `  Default limit is ${defaultMb} MB.\n\n` +
    `  Reply: /approve-fetchsize ${id} or /deny-fetchsize ${id}`
  );
}

// --- Fetch size approve/reject ---

/** Handle /approve-fetchsize and /deny-fetchsize commands. Returns true if command was handled. */
export function handleFetchSizeApproveReject(ctx: PermCtx, input: string): boolean {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-fetchsize' && cmd !== '/deny-fetchsize') return false;

  let id = parts[1];
  if (!id && pendingFetchSizeApprovals.size === 1) {
    id = pendingFetchSizeApprovals.getSingleId();
  }
  if (!id) {
    ctx.injectSystemMessage(pendingFetchSizeApprovals.size === 0
      ? 'No pending fetch size requests.'
      : `Multiple pending — specify ID: ${[...pendingFetchSizeApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingFetchSizeApprovals.resolve(id, ctx);
  if (!pending) {
    if (pendingFetchSizeApprovals.isRecentlyResolved(id)) {
      ctx.injectSystemMessage('Already resolved (auto-approved by updated permissions).');
      pendingFetchSizeApprovals.broadcastDismissed(ctx, [id]);
    }
    return true;
  }

  if (cmd === '/approve-fetchsize') {
    ctx.log.info('Fetch size approved', { id, bytes: pending.requestedBytes });
    ctx.injectSystemMessage(`Approved fetch up to ${(pending.requestedBytes / (1024 * 1024)).toFixed(1)} MB from ${pending.url}`);
    ctx.client!.send({ type: 'fetch_size_response', id, ok: true, approvedBytes: pending.requestedBytes, message: 'Approved by user' });
  } else {
    ctx.log.info('Fetch size denied', { id });
    ctx.injectSystemMessage(`Denied larger fetch from ${pending.url}`);
    ctx.client!.send({ type: 'fetch_size_response', id, ok: false, approvedBytes: pending.defaultBytes, message: 'Denied by user' });
  }
  pendingFetchSizeApprovals.broadcastDismissed(ctx, [id]);
  return true;
}
