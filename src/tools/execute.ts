/**
 * Tool execution and summarization logic.
 *
 * Contains executeTool(), summarizeToolCall(), executeCommand(), parseCurlResponse()
 * and all tool input type definitions. Tool definitions (schemas) live in ./defs.ts.
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sanitizedEnv, validateFetchUrl, validateFetchUrlDns, checkCommandSafety, validateReadonlyCommand, checkSensitivePath } from '../safety.js';
import { auditLog } from '../audit.js';
import type { ToolContentBlock, ImageMediaType } from '../provider.js';
import { fromClaudeCodeName } from './defs.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools');

// --- Curl response parsing ---

/**
 * Extract the response body from raw curl output that includes dumped headers
 * (via -D -). With -L (follow redirects), curl outputs headers for ALL
 * intermediate responses. We find the LAST \r\n\r\n to skip past all headers.
 * If text_only, also strips HTML tags, scripts, styles, and decodes entities.
 */
export function parseCurlResponse(raw: string, textOnly: boolean): string {
  const lastHeaderEnd = raw.lastIndexOf('\r\n\r\n');
  const body = lastHeaderEnd >= 0 ? raw.slice(lastHeaderEnd + 4) : raw;

  if (textOnly) {
    const text = body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return text || '(empty response)';
  }

  return body || '(empty response)';
}

// --- Tool Input Types ---

interface ExecInput { command: string; cwd?: string; timeout?: number }
interface ReadFileInput { path: string; offset?: number; limit?: number }
interface WriteFileInput { path: string; content: string }
interface EditFileInput { path: string; old_text: string; new_text: string }
interface ListFilesInput { path?: string }
interface GrepInput { pattern: string; path?: string; include?: string }
interface FetchInput { url: string; method?: string; headers?: Record<string, string>; body?: string; text_only?: boolean; max_bytes?: number }
interface TreeInput { path?: string; max_depth?: number; include_hidden?: boolean }
interface GlobInput { pattern: string; path?: string; max_results?: number }
interface PatchInput { path: string; edits: Array<{ old_text: string; new_text: string }> }
interface ScreenshotInput { region?: string }
interface SpawnAgentInput { task: string; context?: string; model?: string; max_iterations?: number }
interface DispatchTaskInput { task: string; context?: string; model?: string; max_iterations?: number; delivery?: 'agent-batch' | 'agent-review' | 'user-pull' }
interface HostInput { capability: string; params?: Record<string, unknown>; reason?: string }
interface RequestConfigWriteInput { file: string; content: string; reason: string }
interface HostEditFileInput { path: string; edits: Array<{ old_str: string; new_str: string; index?: number }>; reason: string }
interface SwitchModelInput { model: string; reason?: string }
interface BrowserExtInput { action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab'; tabId?: number; rootSelector?: string; steps?: Record<string, unknown>[]; url?: string }
interface AskUserInput { question: string; options?: { label: string; description?: string }[]; multi_select?: boolean; allow_free_text?: boolean }

type ToolInput = ExecInput | ReadFileInput | WriteFileInput | EditFileInput | ListFilesInput | GrepInput | GlobInput | FetchInput | TreeInput | PatchInput | ScreenshotInput | SpawnAgentInput | DispatchTaskInput | HostInput | RequestConfigWriteInput | HostEditFileInput | SwitchModelInput | BrowserExtInput | AskUserInput;

// --- Tool summarization ---

export function summarizeToolCall(name: string, input: ToolInput, isOAuth: boolean): string {
  const internalName = isOAuth ? fromClaudeCodeName(name) : name;
  switch (internalName) {
    case 'exec':
    case 'exec_readonly': {
      const { command, cwd } = input as ExecInput;
      const short = command.length > 80 ? command.slice(0, 80) + '...' : command;
      return cwd ? `$ ${short} (in ${cwd})` : `$ ${short}`;
    }
    case 'read_file': {
      const { path: rPath, offset, limit } = input as ReadFileInput;
      const range = offset || limit ? ` [${offset ?? 1}:${limit ? `+${limit}` : 'end'}]` : '';
      return `read ${rPath}${range}`;
    }
    case 'write_file': {
      const { path, content } = input as WriteFileInput;
      const lines = content.split('\n').length;
      return `write ${path} (${lines} lines)`;
    }
    case 'edit_file':
      return `edit ${(input as EditFileInput).path}`;
    case 'list_files':
      return `ls ${(input as ListFilesInput).path ?? '.'}`;
    case 'grep': {
      const { pattern, path: p } = input as GrepInput;
      return `grep "${pattern}" ${p ?? '.'}`;
    }
    case 'glob': {
      const { pattern, path: gp } = input as GlobInput;
      return `glob "${pattern}" ${gp ?? '.'}`;
    }
    case 'fetch':
    case 'fetch_readonly': {
      const { url, method } = input as FetchInput;
      return `${(method ?? 'GET').toUpperCase()} ${url.length > 60 ? url.slice(0, 60) + '...' : url}`;
    }
    case 'tree':
      return `tree ${(input as TreeInput).path ?? '.'}`;
    case 'patch':
      return `patch ${(input as PatchInput).path} (${(input as PatchInput).edits?.length ?? 0} edits)`;
    case 'screenshot': {
      const { region } = input as ScreenshotInput;
      return region ? `screenshot (${region})` : 'screenshot';
    }
    case 'spawn_agent': {
      const { task } = input as SpawnAgentInput;
      const short = task.length > 60 ? task.slice(0, 60) + '...' : task;
      return `spawn: ${short}`;
    }
    case 'dispatch_task': {
      const { task } = input as DispatchTaskInput;
      const short = task.length > 60 ? task.slice(0, 60) + '...' : task;
      return `dispatch: ${short}`;
    }
    case 'host': {
      const { capability, reason } = input as HostInput;
      return reason ? `host: ${capability} (${reason.slice(0, 40)})` : `host: ${capability}`;
    }
    case 'request_config_write': {
      const { file } = input as RequestConfigWriteInput;
      return `config write: ${file}`;
    }
    case 'host_edit_file': {
      const { path: p, edits } = input as HostEditFileInput;
      return `edit ${p} (${edits?.length ?? 0} edit${edits?.length === 1 ? '' : 's'})`;
    }
    case 'request_screenshot':
      return 'screenshot from browser';
    case 'search_memory': {
      const { query } = input as { query: string };
      return `search memory: "${query}"`;
    }
    case 'switch_model': {
      const { model: m, reason } = input as SwitchModelInput;
      return reason ? `switch model → ${m} (${reason.slice(0, 40)})` : `switch model → ${m}`;
    }
    case 'browser_ext': {
      const { action, rootSelector, url, steps, tabId } = input as BrowserExtInput;
      if (action === 'activate_tab') return `browser: activate tab ${tabId ?? '?'}`;
      if (action === 'close_tab') return `browser: close tab ${tabId ?? '?'}`;
      if (action === 'open_tab') return `browser: open tab → ${url ?? ''}`;
      if (action === 'navigate') return `browser: navigate → ${url ?? ''}`;
      if (action === 'run_script') {
        const n = steps?.length ?? 0;
        return `browser: run_script (${n} step${n === 1 ? '' : 's'})`;
      }
      return rootSelector ? `browser: ${action} (${rootSelector})` : `browser: ${action}`;
    }
    case 'ask_user': {
      const { question } = input as AskUserInput;
      const short = question.length > 60 ? question.slice(0, 60) + '...' : question;
      return `ask: ${short}`;
    }
    default:
      return name;
  }
}

// --- Command execution ---

function executeCommand(
  command: string,
  cwd?: string,
  timeout = 30_000,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  return new Promise<string>((res) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedEnv(),
      ...(cwd ? { cwd: resolve(cwd) } : {}),
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }, timeout);

    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      onOutput?.(chunk);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      onOutput?.(chunk);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        res(stdout || '(no output)');
      } else {
        const output = `Exit code: ${code ?? 1}\n${stdout}\n${stderr}`.trim();
        res(output || `Exit code: ${code ?? 1}`);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      res(`Error: ${err.message}`);
    });
  });
}

// --- Tool execution ---

export async function executeTool(
  name: string,
  input: ToolInput,
  isOAuth: boolean,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string | ToolContentBlock[]> {
  const internalName = isOAuth ? fromClaudeCodeName(name) : name;
  log.debug('Executing tool', { tool: internalName });

  switch (internalName) {
    case 'exec': {
      const { command, cwd, timeout = 30_000 } = input as ExecInput;
      const safetyWarning = checkCommandSafety(command);
      if (safetyWarning) onOutput?.(`[safety] ${safetyWarning}\n`);

      const { requestExecApproval } = await import('../server.js');
      const approval = await requestExecApproval(command, signal);
      if (!approval.ok) return `Command not allowed: ${approval.message}`;
      return executeCommand(command, cwd, timeout, onOutput);
    }

    case 'exec_readonly': {
      const { command, cwd, timeout = 30_000 } = input as ExecInput;
      const readonlyErr = validateReadonlyCommand(command);
      if (readonlyErr) return readonlyErr;
      return executeCommand(command, cwd, timeout, onOutput);
    }

    case 'fetch_readonly': {
      const fi = input as FetchInput;
      return executeTool('fetch', { ...fi, method: 'GET' }, false, onOutput) as Promise<string>;
    }

    case 'read_file': {
      const { path, offset, limit } = input as ReadFileInput;
      const absPath = resolve(path);
      const sensitivityLevel = checkSensitivePath(absPath);
      if (sensitivityLevel === 'deny') {
        auditLog({ type: 'file_sensitive_block', detail: absPath, reason: 'hard-denied sensitive path' });
        return `Access denied: ${absPath} is a protected path (credentials or system interface)`;
      }
      if (sensitivityLevel === 'prompt') {
        const { requestFileApproval } = await import('../server.js');
        const approval = await requestFileApproval(absPath, 'read', signal);
        auditLog({ type: approval.ok ? 'file_user_approve' : 'file_user_deny', detail: absPath, approved: approval.ok });
        if (!approval.ok) return `File access denied: ${approval.message}`;
      } else {
        auditLog({ type: 'file_read', detail: absPath });
      }
      try {
        const content = readFileSync(absPath, 'utf-8');
        if (!offset && !limit) return content;
        const lines = content.split('\n');
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        const header = `[Lines ${start + 1}-${Math.min(start + slice.length, lines.length)} of ${lines.length}]`;
        return `${header}\n${slice.join('\n')}`;
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return `Error reading file: ${fsErr.message ?? 'unknown error'}`;
      }
    }

    case 'write_file': {
      const { path, content } = input as WriteFileInput;
      const absPath = resolve(path);
      const sensitivityLevel = checkSensitivePath(absPath);
      if (sensitivityLevel === 'deny') {
        auditLog({ type: 'file_sensitive_block', detail: absPath, reason: 'hard-denied sensitive path (write)' });
        return `Access denied: ${absPath} is a protected path`;
      }
      if (sensitivityLevel === 'prompt') {
        const { requestFileApproval } = await import('../server.js');
        const approval = await requestFileApproval(absPath, 'write', signal);
        auditLog({ type: approval.ok ? 'file_user_approve' : 'file_user_deny', detail: absPath, approved: approval.ok });
        if (!approval.ok) return `File write denied: ${approval.message}`;
      } else {
        auditLog({ type: 'file_write', detail: absPath });
      }
      try {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, content, 'utf-8');
        return `Wrote ${content.length} bytes to ${absPath}`;
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return `Error writing file: ${fsErr.message ?? 'unknown error'}`;
      }
    }

    case 'edit_file': {
      const { path, old_text, new_text } = input as EditFileInput;
      const absPath = resolve(path);
      const sensitivityLevel = checkSensitivePath(absPath);
      if (sensitivityLevel === 'deny') {
        auditLog({ type: 'file_sensitive_block', detail: absPath, reason: 'hard-denied sensitive path (edit)' });
        return `Access denied: ${absPath} is a protected path`;
      }
      if (sensitivityLevel === 'prompt') {
        const { requestFileApproval } = await import('../server.js');
        const approval = await requestFileApproval(absPath, 'write', signal);
        auditLog({ type: approval.ok ? 'file_user_approve' : 'file_user_deny', detail: absPath, approved: approval.ok });
        if (!approval.ok) return `File edit denied: ${approval.message}`;
      } else {
        auditLog({ type: 'file_write', detail: absPath });
      }
      try {
        const content = readFileSync(absPath, 'utf-8');
        const index = content.indexOf(old_text);
        if (index === -1) return `Error: old_text not found in ${absPath}. Make sure it matches exactly (including whitespace).`;
        const secondIndex = content.indexOf(old_text, index + 1);
        if (secondIndex !== -1) return `Error: old_text appears multiple times in ${absPath}. Use a more specific match.`;
        const newContent = content.slice(0, index) + new_text + content.slice(index + old_text.length);
        writeFileSync(absPath, newContent, 'utf-8');
        return `Edited ${absPath}`;
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return `Error editing file: ${fsErr.message ?? 'unknown error'}`;
      }
    }

    case 'list_files': {
      const { path: dirPath = '.' } = input as ListFilesInput;
      try {
        const resolved = resolve(dirPath);
        const entries = readdirSync(resolved);
        return entries.map((entry) => {
          try {
            const stat = statSync(resolve(resolved, entry));
            return stat.isDirectory() ? `${entry}/` : entry;
          } catch { return entry; }
        }).join('\n');
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return `Error listing directory: ${fsErr.message ?? 'unknown error'}`;
      }
    }

    case 'grep': {
      const { pattern, path: searchPath = '.', include } = input as GrepInput;
      try {
        const includeArg = include ? `--include="${include}"` : '';
        const cmd = `grep -rn ${includeArg} -- ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`;
        const output = execSync(cmd, {
          encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv(),
        });
        return output || '(no matches)';
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; status?: number };
        if (execErr.status === 1) return '(no matches)';
        return `Error: ${(err as { message?: string }).message ?? 'unknown error'}`;
      }
    }

    case 'fetch': {
      const { url, method = 'GET', headers: reqHeaders, body: reqBody, text_only = false, max_bytes: rawMaxBytes } = input as FetchInput;
      const ssrfErr = validateFetchUrl(url);
      if (ssrfErr) {
        auditLog({ type: 'fetch_ssrf_block', detail: url, reason: ssrfErr });
        return ssrfErr;
      }
      const dnsErr = await validateFetchUrlDns(url);
      if (dnsErr) {
        auditLog({ type: 'fetch_dns_block', detail: url, reason: dnsErr });
        return dnsErr;
      }
      const { requestFetchApproval, requestFetchSizeApproval, FETCH_DEFAULT_BYTES, FETCH_MAX_BYTES_HARD } = await import('../server.js');
      const fetchApproval = await requestFetchApproval(url, method, signal);
      if (!fetchApproval.ok) {
        auditLog({ type: 'fetch_user_deny', detail: url });
        return `Fetch not allowed: ${fetchApproval.message}`;
      }
      let max_bytes: number;
      if (rawMaxBytes === undefined || rawMaxBytes <= FETCH_DEFAULT_BYTES) {
        max_bytes = rawMaxBytes ?? FETCH_DEFAULT_BYTES;
      } else {
        const clamped = Math.min(rawMaxBytes, FETCH_MAX_BYTES_HARD);
        auditLog({ type: 'fetch_size_prompt', detail: url, reason: `Agent requested ${rawMaxBytes} bytes` });
        const sizeApproval = await requestFetchSizeApproval(url, clamped, signal);
        if (!sizeApproval.ok) {
          auditLog({ type: 'fetch_user_deny', detail: url, reason: 'size approval denied' });
          return `Fetch size denied: ${sizeApproval.message}`;
        }
        max_bytes = sizeApproval.approvedBytes;
      }
      auditLog({ type: 'fetch_allow', detail: url });
      try {
        const args: string[] = ['-sS', '-L', '--max-time', '30', '--max-filesize', String(max_bytes)];
        args.push('-X', method.toUpperCase());
        args.push('-D', '-');
        if (reqHeaders) {
          for (const [k, v] of Object.entries(reqHeaders)) args.push('-H', `${k}: ${v}`);
        }
        if (reqBody) args.push('-d', reqBody);
        args.push(url);
        const raw = execSync(`curl ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
          encoding: 'utf-8', timeout: 35_000, maxBuffer: max_bytes + 10_000,
          stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv(),
        });
        return parseCurlResponse(raw, text_only);
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return `Error fetching ${url}: ${e.stderr ?? e.message ?? 'unknown error'}`;
      }
    }

    case 'tree': {
      const { path: rootPath = '.', max_depth = 4, include_hidden = false } = input as TreeInput;
      const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__pycache__', '.next', 'build', 'coverage', '.cache']);
      const lines: string[] = [];
      let fileCount = 0;
      let dirCount = 0;

      function walk(dir: string, prefix: string, depth: number): void {
        if (depth > max_depth) return;
        let entries: string[];
        try { entries = readdirSync(resolve(dir)).sort(); } catch { return; }
        if (!include_hidden) entries = entries.filter((e) => !e.startsWith('.'));
        entries = entries.filter((e) => !SKIP_DIRS.has(e));
        const maxEntries = 100;
        const truncated = entries.length > maxEntries;
        if (truncated) entries = entries.slice(0, maxEntries);
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          const isLast = i === entries.length - 1 && !truncated;
          const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 ';
          const childPrefix = isLast ? '    ' : '\u2502   ';
          const fullPath = resolve(dir, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) { dirCount++; lines.push(`${prefix}${connector}${entry}/`); walk(fullPath, prefix + childPrefix, depth + 1); }
            else { fileCount++; lines.push(`${prefix}${connector}${entry}`); }
          } catch { lines.push(`${prefix}${connector}${entry} [error]`); }
        }
        if (truncated) lines.push(`${prefix}\u2514\u2500\u2500 ... (${entries.length - maxEntries} more)`);
      }

      const resolvedRoot = resolve(rootPath);
      lines.push(resolvedRoot);
      walk(resolvedRoot, '', 0);
      lines.push(`\n${dirCount} directories, ${fileCount} files`);
      return lines.join('\n');
    }

    case 'glob': {
      const { pattern, path: rootPath = '.', max_results = 200 } = input as GlobInput;
      const SKIP_DIRS = ['node_modules', '.git', 'dist', '__pycache__', '.next', 'build', 'coverage', '.cache'];
      const pruneArgs = SKIP_DIRS.map((d) => `-name ${JSON.stringify(d)} -prune`).join(' -o ');
      try {
        const cmd = `find ${JSON.stringify(resolve(rootPath))} \\( ${pruneArgs} \\) -o -name ${JSON.stringify(pattern)} -print | head -n ${max_results}`;
        const output = execSync(cmd, {
          encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv(),
        });
        const results = output.trim();
        if (!results) return '(no matches)';
        const lines = results.split('\n');
        const count = lines.length;
        const suffix = count >= max_results ? `\n\n(results capped at ${max_results})` : '';
        return `${count} file(s) found:\n${results}${suffix}`;
      } catch (err: unknown) {
        const e = err as { stdout?: string; status?: number; message?: string };
        if (e.status === 1 && !e.stdout?.trim()) return '(no matches)';
        return `Error: ${e.message ?? 'unknown error'}`;
      }
    }

    case 'patch': {
      const { path: filePath, edits } = input as PatchInput;
      if (!edits || edits.length === 0) return 'Error: no edits provided';
      try {
        let content = readFileSync(filePath, 'utf-8');
        const applied: string[] = [];
        const failed: string[] = [];
        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i]!;
          const idx = content.indexOf(edit.old_text);
          if (idx === -1) { failed.push(`Edit ${i + 1}: old_text not found`); continue; }
          const secondIdx = content.indexOf(edit.old_text, idx + 1);
          if (secondIdx !== -1) { failed.push(`Edit ${i + 1}: old_text appears multiple times`); continue; }
          content = content.slice(0, idx) + edit.new_text + content.slice(idx + edit.old_text.length);
          applied.push(`Edit ${i + 1}: applied`);
        }
        writeFileSync(filePath, content, 'utf-8');
        const result = [...applied, ...failed].join('\n');
        return `Patched ${filePath} (${applied.length}/${edits.length} edits applied)\n${result}`;
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return `Error patching file: ${fsErr.message ?? 'unknown error'}`;
      }
    }

    case 'screenshot': {
      const { region } = input as ScreenshotInput;
      const display = process.env['DISPLAY'];
      if (!display) return 'Error: No DISPLAY environment variable set. Virtual display (Xvfb) may not be running.';
      try {
        const tmpPath = `/tmp/screenshot-${Date.now()}.png`;
        const importArgs = ['-window', 'root'];
        if (region) importArgs.push('-crop', region);
        importArgs.push(tmpPath);
        execSync(['import', ...importArgs].map((a) => JSON.stringify(a)).join(' '), {
          encoding: 'utf-8', timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'], env: { ...sanitizedEnv(), DISPLAY: display },
        });
        const buffer = readFileSync(tmpPath);
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return [
          { type: 'text', text: `Screenshot captured (${buffer.length} bytes, display ${display})` },
          { type: 'image', mediaType: 'image/png', data: buffer.toString('base64') },
        ] satisfies ToolContentBlock[];
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        return `Error taking screenshot: ${e.stderr ?? e.message ?? 'unknown error'}`;
      }
    }

    case 'request_config_write': {
      const { file, content, reason } = input as RequestConfigWriteInput;
      const validFiles = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md'];
      if (!validFiles.includes(file)) return `Error: ${file} is not a config file. Valid files: ${validFiles.join(', ')}`;
      const { requestConfigWrite } = await import('../server.js');
      const res = await requestConfigWrite(file, content, reason);
      return res.ok ? `Config file ${file} updated. ${res.message}` : `Config write denied: ${res.message}`;
    }

    case 'host_edit_file': {
      const { path: filePath, edits, reason } = input as HostEditFileInput;
      const { requestHostEditFile } = await import('../server.js');
      const res = await requestHostEditFile(filePath, edits, reason);
      return res.ok ? `Edit applied. ${res.message}` : `Edit denied: ${res.message}`;
    }

    case 'host': {
      const { capability, params = {}, reason } = input as HostInput;
      const { getHostClient } = await import('../host-client.js');
      const client = getHostClient();
      if (!client || !client.isConnected()) return 'Host daemon not connected. The user needs to start it on the host with: aigent-host';
      const res = await client.request(capability as import('../host/protocol.js').CapabilityName, params, reason);
      if (!res.ok) return `Host error (${res.error}): ${res.message}`;
      const result = res.result as Record<string, unknown>;
      if (result.type === 'image' && typeof result.data === 'string' && typeof result.mediaType === 'string') {
        return [
          { type: 'text', text: `Clipboard image (${result.mediaType})` },
          { type: 'image', mediaType: result.mediaType as ImageMediaType, data: result.data },
        ] satisfies ToolContentBlock[];
      }
      return JSON.stringify(result, null, 2);
    }

    case 'request_screenshot': {
      const { requestBrowserScreenshot } = await import('../server.js');
      const res = await requestBrowserScreenshot();
      if (!res.ok || !res.data) return res.message || 'Screen sharing not active. Ask the user to click the monitor icon in the input bar to start sharing their screen.';
      return [{ type: 'image', mediaType: (res.mediaType ?? 'image/png') as ImageMediaType, data: res.data }] satisfies ToolContentBlock[];
    }

    case 'search_memory': {
      const { query, days } = input as { query: string; days?: number };
      const searchDays = Math.min(days ?? 30, 365);
      const workspacePath = process.env['AIGENT_WORKSPACE'] ?? '/workspace';
      const memoryDir = `${workspacePath}/memory`;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - searchDays);
      let files: string[];
      try {
        const { readdirSync } = await import('node:fs');
        files = readdirSync(memoryDir)
          .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
          .filter((f) => { const dateStr = f.slice(0, 10); return new Date(dateStr) >= cutoff; })
          .sort().reverse()
          .map((f) => `${memoryDir}/${f}`);
      } catch { return 'No memory logs found.'; }
      if (files.length === 0) return `No memory logs found in the last ${searchDays} days.`;
      const { readFileSync } = await import('node:fs');
      const queryLower = query.toLowerCase();
      const results: string[] = [];
      const MAX_RESULTS = 20;
      const CONTEXT_LINES = 3;
      for (const filePath of files) {
        if (results.length >= MAX_RESULTS) break;
        let content: string;
        try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');
        const date = filePath.split('/').pop()?.replace('.md', '') ?? '';
        const matchedLineNums = new Set<number>();
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(queryLower)) {
            for (let c = Math.max(0, i - CONTEXT_LINES); c <= Math.min(lines.length - 1, i + CONTEXT_LINES); c++) matchedLineNums.add(c);
          }
        }
        if (matchedLineNums.size === 0) continue;
        const sorted = [...matchedLineNums].sort((a, b) => a - b);
        let excerpt = `[${date}]\n`;
        let prev = -2;
        for (const lineNum of sorted) {
          if (lineNum > prev + 1) excerpt += '...\n';
          excerpt += lines[lineNum] + '\n';
          prev = lineNum;
        }
        results.push(excerpt.trim());
        if (results.length >= MAX_RESULTS) break;
      }
      if (results.length === 0) return `No matches for "${query}" in the last ${searchDays} days of memory logs.`;
      return `Found ${results.length} match(es) for "${query}":\n\n${results.join('\n\n---\n\n')}`;
    }

    case 'browser_ext': {
      const { action, tabId, rootSelector, steps, url } = input as BrowserExtInput;
      const { requestBrowserExt } = await import('../server.js');
      const params: { tabId?: number; rootSelector?: string; steps?: unknown[]; url?: string } = {};
      if (tabId !== undefined) params.tabId = tabId;
      if (rootSelector !== undefined) params.rootSelector = rootSelector;
      if (steps !== undefined) params.steps = steps;
      if (url !== undefined) params.url = url;
      return requestBrowserExt(action, params, signal);
    }

    case 'ask_user': {
      const { question, options, multi_select, allow_free_text } = input as AskUserInput;
      const { requestUserQuestion } = await import('../server.js');
      const res = await requestUserQuestion(question, options, multi_select, allow_free_text, signal);
      if (res.dismissed) return 'User dismissed the question without answering.';
      if (res.selectedOptions && res.selectedOptions.length > 0) return `User selected: ${res.selectedOptions.join(', ')}`;
      return `User responded: ${res.answer}`;
    }

    default:
      return `Unknown tool: ${name} (internal: ${internalName})`;
  }
}
