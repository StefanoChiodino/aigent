/**
 * Structured audit logging for security-relevant events.
 *
 * Appends JSON-lines to /tmp/aigent-audit.log (one event per line).
 * Each event is a flat JSON object with a timestamp, event type, detail,
 * and optional reason / approved fields.
 *
 * Usage:
 *   import { auditLog } from './audit.js';
 *   auditLog({ type: 'tier1_block', detail: 'rm -rf /', reason: 'rm on root filesystem' });
 *
 * The log file is safe to tail -f or parse with jq.
 */

import { appendFileSync } from 'node:fs';

let auditLogPath = '/tmp/aigent-audit.log';

/** Override the audit log path — for test isolation only. */
export function _setLogPathForTest(path: string): void {
  auditLogPath = path;
}

export type AuditEventType =
  // Exec pipeline
  | 'exec_tier1_block'
  | 'exec_tier2_allow'
  | 'exec_tier2_deny'
  | 'exec_tier2_force_classify'
  | 'exec_tier3_allow'
  | 'exec_tier3_block'
  | 'exec_tier3_ask'
  | 'exec_user_approve'
  | 'exec_user_deny'
  // File access
  | 'file_read'
  | 'file_write'
  | 'file_write_block'
  | 'file_sensitive_block'
  | 'file_sensitive_prompt'
  | 'file_user_approve'
  | 'file_user_deny'
  // Fetch
  | 'fetch_ssrf_block'
  | 'fetch_dns_block'
  | 'fetch_size_prompt'
  | 'fetch_user_approve'
  | 'fetch_user_deny'
  | 'fetch_allow'
  // MCP
  | 'mcp_tool_prompt'
  | 'mcp_tool_allow'
  | 'mcp_tool_deny'
  | 'mcp_user_approve'
  | 'mcp_user_deny';

export interface AuditEvent {
  type: AuditEventType;
  /** The command, path, URL, or tool name being acted on. */
  detail: string;
  /** Why the action was blocked or classified. */
  reason?: string;
  /** For user-approval events: was the action approved? */
  approved?: boolean;
}

/**
 * Append a structured audit event to /tmp/aigent-audit.log.
 * Fire-and-forget — errors are silently swallowed to never block the main flow.
 */
export function auditLog(event: AuditEvent): void {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    appendFileSync(auditLogPath, line, 'utf-8');
  } catch {
    // Audit logging must never crash the process
  }
}
