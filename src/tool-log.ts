/**
 * Tool call audit trail — appends compact entries to the daily session log
 * so tool execution history survives context compaction.
 *
 * Format: pipe-delimited markdown table rows in workspace/memory/YYYY-MM-DD.md.
 * Fire-and-forget: errors are silently swallowed.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolCallInfo {
  tool: string;
  input: string;
  ms: string;
  ok: boolean;
}

/** Format a single tool call as a markdown table row. */
export function formatToolLogLine(info: ToolCallInfo, reqId?: string): string {
  const time = new Date().toISOString().slice(11, 19);
  const status = info.ok ? 'ok' : 'FAIL';
  const escapedInput = info.input.slice(0, 80).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return `| ${time} | ${info.tool} | ${escapedInput} | ${info.ms}ms | ${status} | ${reqId ?? ''} |`;
}

const TABLE_HEADER =
  '## Tool Calls\n\n' +
  '| Time | Tool | Input | Duration | Status | Req |\n' +
  '|------|------|-------|----------|--------|-----|';

/** Track which daily files already have a tool call header. */
const headeredFiles = new Set<string>();

/** Append a tool call entry to the daily session log. */
export function appendToolLog(memoryDir: string, info: ToolCallInfo, reqId?: string): void {
  try {
    if (!existsSync(memoryDir)) return; // Don't create dir just for tool logs

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(memoryDir, `${dateStr}.md`);

    let prefix = '';
    if (!headeredFiles.has(filePath)) {
      if (!existsSync(filePath)) {
        prefix = `# ${dateStr}\n\n${TABLE_HEADER}\n`;
      } else {
        prefix = `\n${TABLE_HEADER}\n`;
      }
      headeredFiles.add(filePath);
    }

    const line = formatToolLogLine(info, reqId);
    appendFileSync(filePath, `${prefix}${line}\n`, 'utf-8');
  } catch {
    // Non-critical — don't block agent flow
  }
}
