/**
 * Exec command permission handlers.
 *
 * Extracted from gatekeeper.tsx — handles the three-tier exec safety pipeline:
 * Tier 1 (hard deny) → Tier 2 (static allow/deny) → Tier 3 (Haiku classifier) → user prompt.
 */

import { checkExecPermission, checkTier1Deny, DEFAULT_EXEC_PERMISSIONS, type ExecPermissions, parseCommandPipeline, shouldForceClassify } from './safety.js';
import { classifyCommand, isClassifierAvailable } from './classifier.js';
import { readSettingsSync, writeSettingsSync } from './settings-file.js';
import { PendingRequests, type PermCtx } from './gk-perm-utils.js';

// --- State ---

interface PendingExec {
  command: string;
  classifierReason?: string;
  suggestedPatterns?: string[];
}

export const pendingExecApprovals = new PendingRequests<PendingExec>('exec');

// --- Settings readers ---

export function readExecPermissions(): ExecPermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['exec_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_EXEC_PERMISSIONS;
    const p = perms as Partial<ExecPermissions>;
    return {
      alwaysAllow: Array.isArray(p.alwaysAllow)
        ? p.alwaysAllow
        : DEFAULT_EXEC_PERMISSIONS.alwaysAllow,
      alwaysClassify: Array.isArray(p.alwaysClassify)
        ? p.alwaysClassify
        : DEFAULT_EXEC_PERMISSIONS.alwaysClassify,
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_EXEC_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_EXEC_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_EXEC_PERMISSIONS;
  }
}

// --- Pattern derivation ---

/**
 * Derive glob patterns from a command for "always allow".
 * For simple commands, extracts the executable and returns both `"<exe>"` and `"<exe> *"`.
 * For pipelines or commands already containing globs, returns the raw command as-is.
 */
function deriveExecPatterns(command: string): string[] {
  const cmd = command.trim();
  if (cmd.includes('*') || cmd.includes('?') || cmd.includes('[')) return [cmd];
  const segments = parseCommandPipeline(cmd);
  if (segments.length > 1) return [cmd];
  const exe = segments[0]?.executable;
  if (!exe) return [cmd];
  return [exe, `${exe} *`];
}

// --- Settings writers ---

function addCommandToAlwaysAllow(ctx: PermCtx, command: string): void {
  try {
    const patterns = deriveExecPatterns(command);
    writeSettingsSync('gatekeeper:addToExecAlwaysAllow', (settings) => {
      const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.alwaysAllow) ? [...perms.alwaysAllow] : [...DEFAULT_EXEC_PERMISSIONS.alwaysAllow];
      for (const pattern of patterns) {
        if (!current.includes(pattern)) {
          current.push(pattern);
        }
      }
      return { ...settings, exec_permissions: { ...DEFAULT_EXEC_PERMISSIONS, ...perms, alwaysAllow: current } };
    });
    ctx.log.info('Added command to always-allow', { command, patterns });
    ctx.broadcastUpdatedPermissions();
    flushPendingExecApprovals(ctx);
  } catch (err) {
    ctx.log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function addCommandToDenyList(ctx: PermCtx, command: string): void {
  try {
    const patterns = deriveExecPatterns(command);
    writeSettingsSync('gatekeeper:addToExecDeny', (settings) => {
      const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.deny) ? [...perms.deny] : [...DEFAULT_EXEC_PERMISSIONS.deny];
      for (const pattern of patterns) {
        if (!current.includes(pattern)) {
          current.push(pattern);
        }
      }
      return { ...settings, exec_permissions: { ...DEFAULT_EXEC_PERMISSIONS, ...perms, deny: current } };
    });
    ctx.log.info('Added command to deny list', { command, patterns });
    ctx.broadcastUpdatedPermissions();
  } catch (err) {
    ctx.log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function addPatternsToAlwaysAllow(ctx: PermCtx, patterns: string[]): void {
  try {
    writeSettingsSync('gatekeeper:addClassifierPatterns', (settings) => {
      const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.alwaysAllow) ? [...perms.alwaysAllow] : [...DEFAULT_EXEC_PERMISSIONS.alwaysAllow];
      for (const pattern of patterns) {
        if (!current.includes(pattern)) {
          current.push(pattern);
        }
      }
      return { ...settings, exec_permissions: { ...DEFAULT_EXEC_PERMISSIONS, ...perms, alwaysAllow: current } };
    });
    ctx.log.info('Added classifier-suggested patterns to always-allow', { patterns });
    ctx.broadcastUpdatedPermissions();
    flushPendingExecApprovals(ctx);
  } catch (err) {
    ctx.log.error('Failed to update exec permissions', { error: String(err) });
  }
}

// --- Flush ---

/** Re-check pending exec approvals against updated permissions and auto-resolve matches. */
export function flushPendingExecApprovals(ctx: PermCtx): void {
  const yolo = readSettingsSync()['exec_perm_yolo'] === true;
  const permissions = readExecPermissions();
  const dismissed = pendingExecApprovals.flush(
    (_id, pending) => yolo || (checkExecPermission(pending.command, permissions) === 'allow' && !shouldForceClassify(pending.command, permissions.alwaysClassify)),
    (id, pending) => {
      const reason = yolo ? 'YOLO mode' : 'updated permission policy';
      ctx.log.info('Flush: auto-approving pending exec', { id, command: pending.command, reason });
      ctx.auditLog({ type: 'exec_tier2_allow', detail: pending.command });
      ctx.client!.send({ type: 'exec_response', id, ok: true, message: `Allowed by ${reason}` });
    },
  );
  pendingExecApprovals.broadcastDismissed(ctx, dismissed);
}

// --- Request handler ---

/** Handle an exec request from the agent — run through the three-tier safety pipeline. */
export function handleAgentExecRequest(ctx: PermCtx, id: string, command: string): void {
  // --- Tier 1: Static deny (instant block, no override) ---
  const tier1 = checkTier1Deny(command);
  if (tier1) {
    ctx.log.info('Exec blocked by Tier 1 (static deny)', { id, command, reason: tier1 });
    ctx.auditLog({ type: 'exec_tier1_block', detail: command, reason: tier1 });
    pendingExecApprovals.markAutoHandled(id);
    ctx.classifierDecisions.set(id, { tier: 1, action: 'block', reason: tier1 });
    ctx.client!.send({ type: 'exec_response', id, ok: false, message: `Blocked (safety): ${tier1}` });
    ctx.injectSystemMessage(`[exec] Blocked by safety engine: ${tier1}\n  Command: ${command}`);
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  // --- YOLO mode: auto-approve everything that passed Tier 1 ---
  if (readSettingsSync()['exec_perm_yolo'] === true) {
    ctx.log.info('Exec auto-allowed (YOLO mode)', { id, command });
    ctx.auditLog({ type: 'exec_yolo_allow', detail: command });
    pendingExecApprovals.markAutoHandled(id);
    ctx.classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'YOLO mode' });
    ctx.client!.send({ type: 'exec_response', id, ok: true, message: 'Allowed (YOLO mode)' });
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  // --- Tier 2: Static allow/deny (from settings.json) ---
  const permissions = readExecPermissions();
  const level = checkExecPermission(command, permissions);

  if (level === 'allow') {
    if (shouldForceClassify(command, permissions.alwaysClassify)) {
      ctx.log.info('Exec Tier 2 allow overridden by alwaysClassify', { id, command });
      ctx.auditLog({ type: 'exec_tier2_force_classify', detail: command });
      // Fall through to Tier 3 below
    } else {
      ctx.log.info('Exec auto-allowed (Tier 2)', { id, command });
      ctx.auditLog({ type: 'exec_tier2_allow', detail: command });
      pendingExecApprovals.markAutoHandled(id);
      ctx.classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'Allowed by permission policy' });
      ctx.client!.send({ type: 'exec_response', id, ok: true, message: 'Allowed by permission policy' });
      ctx.client!.emit('perm_dismissed', [id]);
      return;
    }
  }

  if (level === 'deny') {
    ctx.log.info('Exec auto-denied (Tier 2)', { id, command });
    ctx.auditLog({ type: 'exec_tier2_deny', detail: command });
    pendingExecApprovals.markAutoHandled(id);
    ctx.classifierDecisions.set(id, { tier: 2, action: 'block', reason: 'Denied by permission policy' });
    ctx.client!.send({ type: 'exec_response', id, ok: false, message: 'Denied by permission policy' });
    ctx.injectSystemMessage(`[exec] Blocked by deny policy: ${command}`);
    ctx.client!.emit('perm_dismissed', [id]);
    return;
  }

  // --- Tier 3: Haiku classifier (async) ---
  if (isClassifierAvailable() && process.env['AIGENT_CLASSIFIER'] !== '0') {
    const recentCtx = ctx.getRecentContext();
    classifyCommand(command, { cwd: process.cwd(), ...(recentCtx ? { recentContext: recentCtx } : {}) })
      .then(result => {
        if (result.action === 'allow') {
          ctx.log.info('Exec auto-allowed (Tier 3 classifier)', { id, command, reason: result.reason });
          ctx.auditLog({ type: 'exec_tier3_allow', detail: command, reason: result.reason });
          pendingExecApprovals.markAutoHandled(id);
          ctx.classifierDecisions.set(id, { tier: 3, action: 'allow', reason: result.reason });
          ctx.client!.send({ type: 'exec_response', id, ok: true, message: `Allowed by classifier: ${result.reason}` });
          ctx.client!.emit('perm_dismissed', [id]);
          return;
        }

        if (result.action === 'block') {
          ctx.log.info('Exec blocked (Tier 3 classifier)', { id, command, reason: result.reason });
          ctx.auditLog({ type: 'exec_tier3_block', detail: command, reason: result.reason });
          pendingExecApprovals.markAutoHandled(id);
          ctx.classifierDecisions.set(id, { tier: 3, action: 'block', reason: result.reason });
          ctx.client!.send({ type: 'exec_response', id, ok: false, message: `Blocked by classifier: ${result.reason}` });
          ctx.injectSystemMessage(`[exec] Blocked by classifier: ${result.reason}\n  Command: ${command}`);
          ctx.client!.emit('perm_dismissed', [id]);
          return;
        }

        // 'ask' — prompt the user with the classifier's assessment
        promptUserForExec(ctx, id, command, result.reason, result.suggestedPatterns);
      })
      .catch(() => {
        // Classifier failed — fall back to user prompt
        promptUserForExec(ctx, id, command);
      });
    return;
  }

  // No classifier — fall back to user prompt
  promptUserForExec(ctx, id, command);
}

// --- User prompt ---

function promptUserForExec(
  ctx: PermCtx,
  id: string,
  command: string,
  classifierReason?: string,
  suggestedPatterns?: string[],
): void {
  pendingExecApprovals.add(id, {
    command,
    ...(classifierReason ? { classifierReason } : {}),
    ...(suggestedPatterns?.length ? { suggestedPatterns } : {}),
  });
  ctx.log.info('Exec approval requested', { id, command, classifierReason, suggestedPatterns });

  let msg = `Agent wants to run: ${command}\n`;
  if (classifierReason) {
    msg += `  Classifier: ${classifierReason}\n`;
  }
  if (suggestedPatterns?.length) {
    msg += `  Suggested always-allow patterns: ${suggestedPatterns.join(', ')}\n`;
  }
  msg += `  Reply: /approve-exec ${id} or /deny-exec ${id}\n`;
  msg += `  To always allow: /approve-exec ${id} --always`;
  msg += `  To always deny: /deny-exec ${id} --always`;
  ctx.injectSystemMessage(msg);
  // Emit to web-bridge so the browser shows a permission modal (gatekeeper-first architecture)
  ctx.client?.emit('ui_exec_prompt', id, command, classifierReason, suggestedPatterns);
}

// --- Approve/reject handler ---

/** Handle /approve-exec and /deny-exec commands. Returns true if command was handled. */
export async function handleExecApproveReject(ctx: PermCtx, input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve-exec') {
    let id = parts[1];
    if (!id && pendingExecApprovals.size === 1) {
      id = pendingExecApprovals.getSingleId();
    }
    if (!id) {
      ctx.injectSystemMessage(pendingExecApprovals.size === 0
        ? 'No pending exec requests.'
        : `Multiple pending — specify ID: ${[...pendingExecApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingExecApprovals.resolve(id, ctx);
    if (!pending) {
      // Request was already auto-resolved — silently ignore
      return true;
    }

    const alwaysAllow = parts.includes('--always');

    if (alwaysAllow) {
      if (pending.suggestedPatterns?.length) {
        addPatternsToAlwaysAllow(ctx, pending.suggestedPatterns);
        ctx.injectSystemMessage(`Approved and added to always-allow: ${pending.suggestedPatterns.join(', ')}`);
      } else {
        addCommandToAlwaysAllow(ctx, pending.command);
        const patterns = deriveExecPatterns(pending.command);
        ctx.injectSystemMessage(`Approved and added to always-allow: ${patterns.join(', ')}`);
      }
    } else {
      ctx.injectSystemMessage(`Approved (once): ${pending.command}`);
    }

    ctx.auditLog({ type: 'exec_user_approve', detail: pending.command, approved: true });
    ctx.client!.send({ type: 'exec_response', id, ok: true, alwaysAllow, message: 'Approved by user' });
    pendingExecApprovals.broadcastDismissed(ctx, [id]);
    return true;
  }

  if (cmd === '/deny-exec') {
    let id = parts[1];
    if (!id && pendingExecApprovals.size === 1) {
      id = pendingExecApprovals.getSingleId();
    }
    if (!id) {
      ctx.injectSystemMessage(pendingExecApprovals.size === 0
        ? 'No pending exec requests.'
        : `Multiple pending — specify ID: ${[...pendingExecApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingExecApprovals.resolve(id, ctx);
    if (!pending) {
      // Request was already auto-resolved — silently ignore
      return true;
    }

    const alwaysDeny = parts.includes('--always');

    if (alwaysDeny) {
      addCommandToDenyList(ctx, pending.command);
      const patterns = deriveExecPatterns(pending.command);
      ctx.injectSystemMessage(`Denied and added to always-deny: ${patterns.join(', ')}`);
    } else {
      ctx.injectSystemMessage(`Denied: ${pending.command}`);
    }

    ctx.auditLog({ type: 'exec_user_deny', detail: pending.command, approved: false });
    ctx.client!.send({ type: 'exec_response', id, ok: false, alwaysAllow: false, message: 'Denied by user' });
    pendingExecApprovals.broadcastDismissed(ctx, [id]);
    return true;
  }

  return false;
}
