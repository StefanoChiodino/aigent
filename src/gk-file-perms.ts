/**
 * File access permission handlers.
 *
 * Extracted from gatekeeper.tsx — handles file read/write approval for
 * sensitive paths and out-of-project locations.
 */

import { dirname } from 'node:path';
import { checkFilePermission, DEFAULT_FILE_PERMISSIONS, type FilePermissions, readFilePermissions } from './safety.js';
import { classifyFileAccess, isClassifierAvailable } from './classifier.js';
import { readSettingsSync, writeSettingsSync } from './settings-file.js';
import { PendingRequests, type PermCtx } from './gk-perm-utils.js';

// --- State ---

interface PendingFileAccess {
  path: string;
  operation: 'read' | 'write';
}

export const pendingFileAccessApprovals = new PendingRequests<PendingFileAccess>('fileAccess');

// --- Settings writers ---

function addPathToFileReadWrite(ctx: PermCtx, pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToFileReadWrite', (settings) => {
      const perms = (settings['file_permissions'] as Partial<FilePermissions> | undefined) ?? {};
      const current = Array.isArray(perms.readWrite) ? [...perms.readWrite] : [...DEFAULT_FILE_PERMISSIONS.readWrite];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, file_permissions: { ...DEFAULT_FILE_PERMISSIONS, ...perms, readWrite: current } };
    });
    ctx.log.info('Added path to file read-write', { pattern });
    ctx.broadcastUpdatedPermissions();
    flushPendingFileAccessApprovals(ctx);
  } catch (err) {
    ctx.log.error('Failed to update file permissions', { error: String(err) });
  }
}

function addPathToFileReadOnly(ctx: PermCtx, pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToFileReadOnly', (settings) => {
      const perms = (settings['file_permissions'] as Partial<FilePermissions> | undefined) ?? {};
      const current = Array.isArray(perms.readOnly) ? [...perms.readOnly] : [...DEFAULT_FILE_PERMISSIONS.readOnly];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, file_permissions: { ...DEFAULT_FILE_PERMISSIONS, ...perms, readOnly: current } };
    });
    ctx.log.info('Added path to file read-only', { pattern });
    ctx.broadcastUpdatedPermissions();
    flushPendingFileAccessApprovals(ctx);
  } catch (err) {
    ctx.log.error('Failed to update file permissions', { error: String(err) });
  }
}

// --- Flush ---

/** Re-check pending file access approvals against updated permissions and auto-resolve matches. */
export function flushPendingFileAccessApprovals(ctx: PermCtx): void {
  const yolo = readSettingsSync()['file_perm_yolo'] === true;
  const permissions = readFilePermissions();
  const dismissed = pendingFileAccessApprovals.flush(
    (_id, pending) => yolo || checkFilePermission(pending.path, permissions, pending.operation) === 'allow',
    (id, pending) => {
      const reason = yolo ? 'YOLO mode' : 'updated file permission policy';
      ctx.log.info('Flush: auto-approving pending file access', { id, path: pending.path, operation: pending.operation, reason });
      ctx.client!.send({ type: 'file_access_response', id, ok: true, message: `Allowed by ${reason}` });
    },
  );
  pendingFileAccessApprovals.broadcastDismissed(ctx, dismissed);
}

// --- Request handler ---

/** Handle a file access request from the agent. */
export function handleAgentFileAccessRequest(ctx: PermCtx, id: string, path: string, operation: 'read' | 'write', reason: string): void {
  // --- YOLO mode: auto-approve all file access ---
  if (readSettingsSync()['file_perm_yolo'] === true) {
    const auditType = operation === 'read' ? 'file_read' : 'file_write';
    ctx.log.info(`File ${operation} auto-allowed (YOLO mode)`, { id, path });
    ctx.auditLog({ type: `${auditType}_yolo_allow`, detail: path });
    pendingFileAccessApprovals.markAutoHandled(id);
    ctx.classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'YOLO mode' });
    ctx.client!.send({ type: 'file_access_response', id, ok: true, message: 'Allowed (YOLO mode)' });
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  // Check file permissions (deny/readOnly/readWrite)
  const filePerms = readFilePermissions();
  const level = checkFilePermission(path, filePerms, operation);

  if (level === 'allow') {
    const auditType = operation === 'read' ? 'file_read' : 'file_write';
    ctx.log.info(`File ${operation} auto-allowed by permission policy`, { id, path });
    ctx.auditLog({ type: auditType, detail: path, reason: 'allowed by file_permissions' });
    pendingFileAccessApprovals.markAutoHandled(id);
    ctx.classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'Allowed by file_permissions' });
    ctx.client!.send({ type: 'file_access_response', id, ok: true, message: 'Allowed by file permission policy' });
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }
  if (level === 'deny') {
    const auditType = operation === 'read' ? 'file_read_block' : 'file_write_block';
    ctx.log.info(`File ${operation} auto-denied by permission policy`, { id, path });
    ctx.auditLog({ type: auditType, detail: path, reason: 'denied by file_permissions' });
    pendingFileAccessApprovals.markAutoHandled(id);
    ctx.classifierDecisions.set(id, { tier: 2, action: 'block', reason: 'Denied by file_permissions' });
    ctx.client!.send({ type: 'file_access_response', id, ok: false, message: 'Denied by file permission policy' });
    ctx.client!.emit('perm_dismissed', [id]);
    ctx.injectSystemMessage(`[file] Blocked by ${operation === 'write' ? 'deny/read-only' : 'deny'} policy: ${path}`);
    return;
  }

  // --- Tier 3: Haiku file access classifier (async) ---
  if (isClassifierAvailable() && process.env['AIGENT_CLASSIFIER'] !== '0') {
    const recentCtx = ctx.getRecentContext();
    classifyFileAccess(path, operation, { cwd: process.cwd(), ...(recentCtx ? { recentContext: recentCtx } : {}) })
      .then(result => {
        if (result.action === 'allow') {
          const auditType = operation === 'read' ? 'file_read' : 'file_write';
          ctx.log.info(`File ${operation} auto-allowed (Tier 3 classifier)`, { id, path, reason: result.reason });
          ctx.auditLog({ type: auditType, detail: path, reason: `classifier: ${result.reason}` });
          pendingFileAccessApprovals.markAutoHandled(id);
          ctx.classifierDecisions.set(id, { tier: 3, action: 'allow', reason: result.reason });
          ctx.client!.send({ type: 'file_access_response', id, ok: true, message: `Allowed by classifier: ${result.reason}` });
          ctx.client!.emit('perm_dismissed', [id]);
          return;
        }

        if (result.action === 'block') {
          const auditType = operation === 'read' ? 'file_read_block' : 'file_write_block';
          ctx.log.info(`File ${operation} blocked (Tier 3 classifier)`, { id, path, reason: result.reason });
          ctx.auditLog({ type: auditType, detail: path, reason: `classifier: ${result.reason}` });
          pendingFileAccessApprovals.markAutoHandled(id);
          ctx.classifierDecisions.set(id, { tier: 3, action: 'block', reason: result.reason });
          ctx.client!.send({ type: 'file_access_response', id, ok: false, message: `Blocked by classifier: ${result.reason}` });
          ctx.client!.emit('perm_dismissed', [id]);
          ctx.injectSystemMessage(`[file] Blocked by classifier: ${result.reason}\n  Path: ${path}`);
          return;
        }

        // 'ask' — prompt the user with the classifier's assessment
        promptUserForFileAccess(ctx, id, path, operation, reason, result.reason, result.suggestedPatterns);
      })
      .catch(() => {
        // Classifier failed — fall back to user prompt
        promptUserForFileAccess(ctx, id, path, operation, reason);
      });
    return;
  }

  // No classifier — fall back to user prompt
  promptUserForFileAccess(ctx, id, path, operation, reason);
}

// --- User prompt ---

function promptUserForFileAccess(
  ctx: PermCtx,
  id: string,
  path: string,
  operation: 'read' | 'write',
  reason: string,
  classifierReason?: string,
  _suggestedPatterns?: string[],
): void {
  pendingFileAccessApprovals.add(id, { path, operation });
  ctx.log.info('File access approval requested', { id, path, operation, classifierReason });
  let msg = `Agent wants to ${operation.toUpperCase()} file outside project or in a sensitive location:\n` +
    `  Path: ${path}\n` +
    `  Reason: "${reason}"\n`;
  if (classifierReason) {
    msg += `  Classifier: ${classifierReason}\n`;
  }
  msg += `\n  Reply: /approve-file ${id} or /deny-file ${id}\n` +
    `  To always allow this file (read-write): /approve-file ${id} --always\n` +
    `  To always allow this directory (read-write): /approve-file ${id} --always-dir\n` +
    `  To allow read-only: /approve-file ${id} --read-only\n` +
    `  To allow read-only for directory: /approve-file ${id} --read-only-dir`;
  ctx.injectSystemMessage(msg);
  // Emit to web-bridge so the browser shows a permission modal (gatekeeper-first architecture)
  ctx.client?.emit('ui_file_access_prompt', id, path, operation, reason, classifierReason);
}

// --- Approve/reject handler ---

/** Handle /approve-file and /deny-file commands. Returns true if command was handled. */
export function handleFileAccessApproveReject(ctx: PermCtx, input: string): boolean {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-file' && cmd !== '/deny-file') return false;

  let id = parts[1];
  // If the first arg is a flag, not an id, and there's only one pending request
  if (id && id.startsWith('--')) id = undefined;
  if (!id && pendingFileAccessApprovals.size === 1) {
    id = pendingFileAccessApprovals.getSingleId();
  }
  if (!id) {
    ctx.injectSystemMessage(pendingFileAccessApprovals.size === 0
      ? 'No pending file access requests.'
      : `Multiple pending — specify ID: ${[...pendingFileAccessApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingFileAccessApprovals.resolve(id, ctx);
  if (!pending) {
    if (pendingFileAccessApprovals.isRecentlyResolved(id)) {
      ctx.injectSystemMessage('Already resolved (auto-approved by updated permissions).');
      pendingFileAccessApprovals.broadcastDismissed(ctx, [id]);
    }
    return true;
  }

  if (cmd === '/approve-file') {
    const isReadOnly = parts.includes('--read-only') || parts.includes('--read-only-dir');
    const isDir = parts.includes('--always-dir') || parts.includes('--read-only-dir');
    const isPersistent = parts.includes('--always') || isDir || isReadOnly;

    if (isDir) {
      const dirPattern = dirname(pending.path) + '/**';
      if (isReadOnly) {
        addPathToFileReadOnly(ctx, dirPattern);
        ctx.injectSystemMessage(`Approved and directory added to read-only: ${dirPattern}`);
      } else {
        addPathToFileReadWrite(ctx, dirPattern);
        ctx.injectSystemMessage(`Approved and directory added to read-write: ${dirPattern}`);
      }
    } else if (isReadOnly) {
      addPathToFileReadOnly(ctx, pending.path);
      ctx.injectSystemMessage(`Approved and path added to read-only: ${pending.path}`);
    } else if (isPersistent) {
      addPathToFileReadWrite(ctx, pending.path);
      ctx.injectSystemMessage(`Approved and path added to read-write: ${pending.path}`);
    } else {
      ctx.injectSystemMessage(`Approved (once): ${pending.path}`);
    }

    ctx.log.info('File access approved', { id, path: pending.path, persistent: isPersistent, readOnly: isReadOnly, dir: isDir });
    ctx.client!.send({ type: 'file_access_response', id, ok: true, message: 'Approved by user' });
  } else {
    ctx.log.info('File access denied', { id, path: pending.path });
    ctx.injectSystemMessage(`Denied file ${pending.operation}: ${pending.path}`);
    ctx.client!.send({ type: 'file_access_response', id, ok: false, message: 'Denied by user' });
  }
  pendingFileAccessApprovals.broadcastDismissed(ctx, [id]);
  return true;
}
