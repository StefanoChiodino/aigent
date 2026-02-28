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
import { getReqId } from './req-context.js';
import { rotateIfNeeded } from './log-rotate.js';

let auditLogPath = '/tmp/aigent-audit.log';

// Rotate audit log at startup (fire-and-forget)
try { rotateIfNeeded(auditLogPath); } catch { /* non-critical */ }

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
  | 'exec_yolo_allow'
  // File access
  | 'file_read'
  | 'file_read_block'
  | 'file_write'
  | 'file_write_block'
  | 'file_sensitive_block'
  | 'file_sensitive_prompt'
  | 'file_user_approve'
  | 'file_user_deny'
  | 'file_read_yolo_allow'
  | 'file_write_yolo_allow'
  // Fetch
  | 'fetch_ssrf_block'
  | 'fetch_dns_block'
  | 'fetch_size_prompt'
  | 'fetch_user_approve'
  | 'fetch_user_deny'
  | 'fetch_allow'
  | 'fetch_yolo_allow'
  // MCP
  | 'mcp_tool_prompt'
  | 'mcp_tool_allow'
  | 'mcp_tool_deny'
  | 'mcp_user_approve'
  | 'mcp_user_deny'
  // Browser extension
  | 'browser_ext_read'
  | 'browser_ext_write_grant'
  | 'browser_ext_write_prompt'
  | 'browser_ext_domain_grant'
  | 'browser_ext_domain_deny'
  | 'browser_ext_prompt'
  | 'browser_ext_user_approve'
  | 'browser_ext_user_deny'
  | 'browser_ext_destructive_prompt'
  | 'browser_ext_ssrf_block';

export interface AuditEvent {
  type: AuditEventType;
  /** The command, path, URL, or tool name being acted on. */
  detail: string;
  /** Why the action was blocked or classified. */
  reason?: string;
  /** For user-approval events: was the action approved? */
  approved?: boolean;
  /** Correlation ID for tracing across processes. Auto-read from AsyncLocalStorage if omitted. */
  reqId?: string;
}

/**
 * Append a structured audit event to /tmp/aigent-audit.log.
 * Fire-and-forget — errors are silently swallowed to never block the main flow.
 */
export function auditLog(event: AuditEvent): void {
  try {
    const rid = event.reqId ?? getReqId();
    const obj: Record<string, unknown> = { ts: Date.now() };
    if (rid) obj.reqId = rid;
    obj.type = event.type;
    obj.detail = event.detail;
    if (event.reason !== undefined) obj.reason = event.reason;
    if (event.approved !== undefined) obj.approved = event.approved;
    appendFileSync(auditLogPath, JSON.stringify(obj) + '\n', 'utf-8');
  } catch {
    // Audit logging must never crash the process
  }
}
