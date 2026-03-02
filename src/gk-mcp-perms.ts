/**
 * MCP tool permission handlers.
 *
 * Extracted from gatekeeper.tsx — handles MCP tool call approval
 * based on per-server/per-tool permission configuration.
 */

import { checkMCPPermission, DEFAULT_MCP_PERMISSIONS, type MCPPermissions } from './safety.js';
import { readSettingsSync, writeSettingsSync } from './settings-file.js';
import { PendingRequests, type PermCtx } from './gk-perm-utils.js';

// --- State ---

interface PendingMcpTool {
  server: string;
  tool: string;
  params: string;
}

export const pendingMcpToolApprovals = new PendingRequests<PendingMcpTool>('mcpTool');

// --- Settings readers ---

export function readMCPPermissions(): MCPPermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['mcp_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_MCP_PERMISSIONS;
    const p = perms as Partial<MCPPermissions>;
    return {
      servers: (p.servers && typeof p.servers === 'object') ? p.servers : {},
    };
  } catch {
    return DEFAULT_MCP_PERMISSIONS;
  }
}

// --- Settings writers ---

function addMCPToolToAlwaysAllow(ctx: PermCtx, server: string, tool: string): void {
  try {
    writeSettingsSync('gatekeeper:addToMCPAlwaysAllow', (settings) => {
      const perms = (settings['mcp_permissions'] as Partial<MCPPermissions> | undefined) ?? {};
      const servers = (perms.servers && typeof perms.servers === 'object') ? { ...perms.servers } : {};
      const existing = servers[server];
      const serverPerms = existing ? { ...existing } : { default: 'prompt' as const };
      const tools = serverPerms.tools ? { ...serverPerms.tools } : {};
      tools[tool] = 'allow';
      serverPerms.tools = tools;
      servers[server] = serverPerms;
      return { ...settings, mcp_permissions: { servers } };
    });
    ctx.log.info('Added MCP tool to always-allow', { server, tool });
    ctx.broadcastUpdatedPermissions();
    flushPendingMCPApprovals(ctx);
  } catch (err) {
    ctx.log.error('Failed to update MCP permissions', { error: String(err) });
  }
}

// --- Flush ---

/** Re-check pending MCP tool approvals against updated permissions and auto-resolve matches. */
export function flushPendingMCPApprovals(ctx: PermCtx): void {
  const permissions = readMCPPermissions();
  const dismissed = pendingMcpToolApprovals.flush(
    (_id, pending) => checkMCPPermission(pending.server, pending.tool, permissions) === 'allow',
    (id, pending) => {
      ctx.log.info('Flush: auto-approving pending MCP tool', { id, server: pending.server, tool: pending.tool });
      ctx.auditLog({ type: 'mcp_tool_allow', detail: `${pending.server}/${pending.tool}` });
      ctx.client!.send({ type: 'mcp_tool_response', id, ok: true, message: 'Allowed by permission policy' });
    },
  );
  pendingMcpToolApprovals.broadcastDismissed(ctx, dismissed);
}

// --- Request handler ---

/** Handle an MCP tool call request from the agent. */
export function handleAgentMcpToolRequest(ctx: PermCtx, id: string, server: string, tool: string, params: string): void {
  const permissions = readMCPPermissions();
  const level = checkMCPPermission(server, tool, permissions);

  if (level === 'allow') {
    ctx.log.info('MCP tool auto-allowed', { id, server, tool });
    ctx.auditLog({ type: 'mcp_tool_allow', detail: `${server}/${tool}` });
    pendingMcpToolApprovals.markAutoHandled(id);
    ctx.client!.send({ type: 'mcp_tool_response', id, ok: true, message: 'Allowed by permission policy' });
    return;
  }

  if (level === 'deny') {
    ctx.log.info('MCP tool auto-denied', { id, server, tool });
    ctx.auditLog({ type: 'mcp_tool_deny', detail: `${server}/${tool}` });
    pendingMcpToolApprovals.markAutoHandled(id);
    ctx.client!.send({ type: 'mcp_tool_response', id, ok: false, message: 'Denied by permission policy' });
    ctx.injectSystemMessage(`[mcp] Blocked by deny policy: ${server}/${tool}`);
    return;
  }

  // 'prompt' — store and forward to web UI for user approval
  pendingMcpToolApprovals.add(id, { server, tool, params });
  ctx.log.info('MCP tool approval requested', { id, server, tool });
  ctx.auditLog({ type: 'mcp_tool_prompt', detail: `${server}/${tool}` });
  const paramsPreview = params.length > 200 ? params.slice(0, 200) + '\n  ...' : params;
  ctx.injectSystemMessage(
    `Agent wants to call MCP tool: ${server}/${tool}\n` +
    `  Parameters:\n${paramsPreview}\n\n` +
    `  Reply: /approve-mcp ${id} or /deny-mcp ${id}\n` +
    `  To always allow this tool: /approve-mcp ${id} --always`
  );
}

// --- Approve/reject handler ---

/** Handle /approve-mcp and /deny-mcp commands. Returns true if command was handled. */
export function handleMcpToolApproveReject(ctx: PermCtx, input: string): boolean {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-mcp' && cmd !== '/deny-mcp') return false;

  const hasAlways = parts.includes('--always');
  let id = parts.find(p => p !== cmd && p !== '--always');
  if (!id && pendingMcpToolApprovals.size === 1) {
    id = pendingMcpToolApprovals.getSingleId();
  }
  if (!id) {
    ctx.injectSystemMessage(pendingMcpToolApprovals.size === 0
      ? 'No pending MCP tool requests.'
      : `Multiple pending — specify ID: ${[...pendingMcpToolApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingMcpToolApprovals.resolve(id, ctx);
  if (!pending) {
    if (pendingMcpToolApprovals.isRecentlyResolved(id)) {
      ctx.injectSystemMessage('Already resolved (auto-approved by updated permissions).');
      pendingMcpToolApprovals.broadcastDismissed(ctx, [id]);
    }
    return true;
  }

  if (cmd === '/approve-mcp') {
    ctx.log.info('MCP tool approved', { id, server: pending.server, tool: pending.tool, always: hasAlways });
    ctx.auditLog({ type: 'mcp_user_approve', detail: `${pending.server}/${pending.tool}` });
    ctx.injectSystemMessage(`Approved MCP tool: ${pending.server}/${pending.tool}${hasAlways ? ' (always)' : ''}`);
    ctx.client!.send({ type: 'mcp_tool_response', id, ok: true, message: 'Approved by user' });
    if (hasAlways) {
      addMCPToolToAlwaysAllow(ctx, pending.server, pending.tool);
    }
  } else {
    ctx.log.info('MCP tool denied', { id, server: pending.server, tool: pending.tool });
    ctx.auditLog({ type: 'mcp_user_deny', detail: `${pending.server}/${pending.tool}` });
    ctx.injectSystemMessage(`Denied MCP tool: ${pending.server}/${pending.tool}`);
    ctx.client!.send({ type: 'mcp_tool_response', id, ok: false, message: 'Denied by user' });
  }
  pendingMcpToolApprovals.broadcastDismissed(ctx, [id]);
  return true;
}
