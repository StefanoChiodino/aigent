/**
 * Config write and host edit-file approval handlers.
 *
 * Extracted from gatekeeper.tsx to keep the main file focused on
 * safety pipeline and lifecycle concerns.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDisplayDiff } from './diff.js';
import type { createLogger } from './logger.js';

// --- Context interface ---

export interface ConfigWriteContext {
  /** The AgentClient — used for sending responses back to the worker. */
  client: { send(msg: unknown): void; emit(event: string, ...args: unknown[]): void } | null;
  log: ReturnType<typeof createLogger>;
  injectSystemMessage(content: string): void;
  IS_TEST_MODE: boolean;
  REPO_DIR: string;
  resolveHostPath(input: string): string;
}

// --- Config write requests ---

const VALID_CONFIG_FILES = new Set(['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md']);
const pendingConfigWriteRequests = new Map<string, { file: string; content: string }>();

export function handleConfigWriteRequest(ctx: ConfigWriteContext, id: string, file: string, content: string, reason: string): void {
  if (!VALID_CONFIG_FILES.has(file)) {
    ctx.client!.send({ type: 'config_write_response', id, ok: false, message: `${file} is not a config file` });
    return;
  }

  const configPath = join(ctx.REPO_DIR, 'workspace', 'config', file);
  const fallbackPath = join(ctx.REPO_DIR, 'workspace', file);
  let current = '';
  try {
    current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') :
              existsSync(fallbackPath) ? readFileSync(fallbackPath, 'utf-8') : '';
  } catch {}

  const currentLines = current.split('\n');
  const newLines = content.split('\n');
  const added = newLines.filter((l) => !currentLines.includes(l)).length;
  const removed = currentLines.filter((l) => !newLines.includes(l)).length;

  pendingConfigWriteRequests.set(id, { file, content });

  ctx.injectSystemMessage(
    `Agent wants to edit config/${file}:\n` +
    `  Reason: "${reason}"\n` +
    `  Changes: +${added} lines, -${removed} lines\n` +
    `  New size: ${content.length} bytes\n\n` +
    `Reply: /approve or /reject\n` +
    `Preview: /preview`
  );
}

export async function handleConfigApproveReject(ctx: ConfigWriteContext, input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve') {
    let id = parts[1];
    if (!id && pendingConfigWriteRequests.size === 1) {
      id = pendingConfigWriteRequests.keys().next().value as string;
    }
    if (!id) {
      ctx.injectSystemMessage(pendingConfigWriteRequests.size === 0
        ? 'No pending config writes.'
        : `Multiple pending — specify ID: ${[...pendingConfigWriteRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      if (!ctx.IS_TEST_MODE) ctx.injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    pendingConfigWriteRequests.delete(id);

    const configDir = join(ctx.REPO_DIR, 'workspace', 'config');
    mkdirSync(configDir, { recursive: true });
    const filePath = join(configDir, pending.file);
    try {
      writeFileSync(filePath, pending.content);
      writeFileSync(join(ctx.REPO_DIR, 'workspace', pending.file), pending.content);

      ctx.log.info('Config write approved', { id, file: pending.file });
      ctx.client!.send({ type: 'config_write_response', id, ok: true, message: `${pending.file} updated` });
      ctx.injectSystemMessage(`Approved: config/${pending.file} updated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.client!.send({ type: 'config_write_response', id, ok: false, message: msg });
      ctx.injectSystemMessage(`Failed to write ${pending.file}: ${msg}`);
    }
    return true;
  }

  if (cmd === '/reject') {
    let id = parts[1];
    if (!id && pendingConfigWriteRequests.size === 1) {
      id = pendingConfigWriteRequests.keys().next().value as string;
    }
    if (!id) {
      ctx.injectSystemMessage(pendingConfigWriteRequests.size === 0
        ? 'No pending config writes.'
        : `Multiple pending — specify ID: ${[...pendingConfigWriteRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      if (!ctx.IS_TEST_MODE) ctx.injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    pendingConfigWriteRequests.delete(id);
    ctx.log.info('Config write rejected', { id, file: pending.file });
    ctx.client!.send({ type: 'config_write_response', id, ok: false, message: 'Config write rejected by user' });
    ctx.injectSystemMessage(`Rejected config write to ${pending.file}`);
    return true;
  }

  if (cmd === '/preview') {
    let id = parts[1];
    if (!id && pendingConfigWriteRequests.size === 1) {
      id = pendingConfigWriteRequests.keys().next().value as string;
    }
    if (!id) {
      ctx.injectSystemMessage(pendingConfigWriteRequests.size === 0
        ? 'No pending config writes.'
        : `Multiple pending — specify ID: ${[...pendingConfigWriteRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      if (!ctx.IS_TEST_MODE) ctx.injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    const preview = pending.content.length > 2000
      ? pending.content.slice(0, 2000) + '\n\n... [truncated]'
      : pending.content;
    ctx.injectSystemMessage(`Preview of ${pending.file}:\n\n${preview}`);
    return true;
  }

  return false;
}

// --- Host edit-file requests (str_replace with index disambiguation) ---

interface ResolvedEdit {
  old_str: string;
  new_str: string;
  occurrenceIndex: number;
  lineNumber: number;
}

interface PendingEditFile {
  hostPath: string;
  originalContent: string;
  resolvedEdits: ResolvedEdit[];
  reason: string;
}

const pendingEditFileRequests = new Map<string, PendingEditFile>();

function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + 1;
  }
  return positions;
}

function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

export function handleEditFileRequest(
  ctx: ConfigWriteContext,
  id: string,
  containerPath: string,
  edits: Array<{ old_str: string; new_str: string; index?: number }>,
  reason: string,
): void {
  const hostPath = ctx.resolveHostPath(containerPath);

  let originalContent: string;
  try {
    originalContent = readFileSync(hostPath, 'utf-8');
  } catch {
    ctx.client!.send({ type: 'edit_file_response', id, ok: false, message: `Cannot read ${hostPath}` });
    return;
  }

  const resolvedEdits: ResolvedEdit[] = [];
  let workingContent = originalContent;
  let lineOffset = 0;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const positions = findAllOccurrences(workingContent, edit.old_str);

    if (positions.length === 0) {
      ctx.client!.send({ type: 'edit_file_response', id, ok: false, message: `Edit ${i + 1}: old_str not found in ${hostPath}` });
      return;
    }

    if (positions.length > 1 && edit.index === undefined) {
      const lineNumbers = positions.map((p) => lineOfOffset(workingContent, p) + lineOffset);
      ctx.client!.send({
        type: 'edit_file_response',
        id,
        ok: false,
        message:
          `Edit ${i + 1}: old_str matches ${positions.length} times in ${hostPath} at lines [${lineNumbers.join(', ')}]. ` +
          `Retry with index (0-based) to select which occurrence to replace.`,
      });
      return;
    }

    const occurrenceIndex = edit.index ?? 0;
    if (occurrenceIndex < 0 || occurrenceIndex >= positions.length) {
      ctx.client!.send({
        type: 'edit_file_response',
        id,
        ok: false,
        message: `Edit ${i + 1}: index ${occurrenceIndex} out of range — only ${positions.length} occurrence(s) found.`,
      });
      return;
    }

    const charPos = positions[occurrenceIndex]!;
    const lineNumber = lineOfOffset(workingContent, charPos) + lineOffset;

    resolvedEdits.push({ old_str: edit.old_str, new_str: edit.new_str, occurrenceIndex, lineNumber });

    workingContent =
      workingContent.slice(0, charPos) +
      edit.new_str +
      workingContent.slice(charPos + edit.old_str.length);

    lineOffset += edit.new_str.split('\n').length - edit.old_str.split('\n').length;
  }

  pendingEditFileRequests.set(id, { hostPath, originalContent, resolvedEdits, reason });

  const diff = buildDisplayDiff(originalContent, workingContent, hostPath);
  const editSummary = resolvedEdits.map((e, i) =>
    `  Edit ${i + 1}: replace occurrence ${e.occurrenceIndex} at line ${e.lineNumber}`
  ).join('\n');

  if (ctx.client) {
    ctx.client.emit('patch_request', id, diff, reason);
  } else {
    ctx.injectSystemMessage(
      `Agent wants to edit ${hostPath}\n` +
      `  Reason: "${reason}"\n` +
      `  ${resolvedEdits.length} edit${resolvedEdits.length > 1 ? 's' : ''}:\n${editSummary}\n\n` +
      `\`\`\`diff\n${diff}\n\`\`\`\n\n` +
      `Reply: /approve-edit or /reject-edit`
    );
  }
}

export async function handleEditFileApproveReject(ctx: ConfigWriteContext, input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve-edit' || cmd === '/approve-patch') {
    let id = parts[1];
    if (!id && pendingEditFileRequests.size === 1) {
      id = pendingEditFileRequests.keys().next().value as string;
    }
    if (!id) {
      ctx.injectSystemMessage(pendingEditFileRequests.size === 0
        ? 'No pending edit requests.'
        : `Multiple pending — specify ID: ${[...pendingEditFileRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingEditFileRequests.get(id);
    if (!pending) {
      if (!ctx.IS_TEST_MODE) ctx.injectSystemMessage(`No pending edit request: ${id}`);
      return true;
    }

    pendingEditFileRequests.delete(id);

    let content = pending.originalContent;
    for (let i = 0; i < pending.resolvedEdits.length; i++) {
      const edit = pending.resolvedEdits[i]!;
      const positions = findAllOccurrences(content, edit.old_str);
      if (positions.length === 0 || edit.occurrenceIndex >= positions.length) {
        const msg = `Edit ${i + 1}: file changed since approval — old_str no longer found at expected position.`;
        ctx.log.error('Edit apply failed', { id, error: msg });
        ctx.client!.send({ type: 'edit_file_response', id, ok: false, message: msg });
        ctx.injectSystemMessage(`Edit failed: ${msg}`);
        return true;
      }
      const charPos = positions[edit.occurrenceIndex]!;
      content = content.slice(0, charPos) + edit.new_str + content.slice(charPos + edit.old_str.length);
    }

    try {
      writeFileSync(pending.hostPath, content, 'utf-8');
      ctx.log.info('Edit applied', { id, path: pending.hostPath, edits: pending.resolvedEdits.length });
      ctx.client!.send({ type: 'edit_file_response', id, ok: true, message: `Applied ${pending.resolvedEdits.length} edit(s) to ${pending.hostPath}` });
      ctx.injectSystemMessage(`Approved: edit applied to ${pending.hostPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.error('Edit write failed', { id, error: msg });
      ctx.client!.send({ type: 'edit_file_response', id, ok: false, message: `Write failed: ${msg}` });
      ctx.injectSystemMessage(`Edit failed: ${msg}`);
    }
    return true;
  }

  if (cmd === '/reject-edit' || cmd === '/reject-patch') {
    let id = parts[1];
    if (!id && pendingEditFileRequests.size === 1) {
      id = pendingEditFileRequests.keys().next().value as string;
    }
    if (!id) {
      ctx.injectSystemMessage(pendingEditFileRequests.size === 0
        ? 'No pending edit requests.'
        : `Multiple pending — specify ID: ${[...pendingEditFileRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingEditFileRequests.get(id);
    if (!pending) {
      if (!ctx.IS_TEST_MODE) ctx.injectSystemMessage(`No pending edit request: ${id}`);
      return true;
    }

    pendingEditFileRequests.delete(id);
    ctx.log.info('Edit rejected', { id });
    ctx.client!.send({ type: 'edit_file_response', id, ok: false, message: 'Edit rejected by user' });
    ctx.injectSystemMessage(`Rejected edit for ${pending.hostPath}`);
    return true;
  }

  return false;
}
