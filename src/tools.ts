import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Tool definition — provider-agnostic. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Claude Code canonical tool names.
 * When using OAT (subscription) auth, we must use these exact names.
 * Bidirectional mapping between internal names and CC names.
 */
const INTERNAL_TO_CC: Record<string, string> = {
  exec: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  // Tools without CC equivalents pass through unchanged
};

const CC_TO_INTERNAL: Record<string, string> = {
  bash: 'exec',
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  grep: 'grep',
  glob: 'glob',
};

export function toClaudeCodeName(name: string): string {
  return INTERNAL_TO_CC[name] ?? name;
}

export function fromClaudeCodeName(name: string): string {
  return CC_TO_INTERNAL[name.toLowerCase()] ?? name;
}

// --- Tool Definitions ---

const execTool: ToolDef = {
  name: 'exec',
  description:
    'Execute a shell command and return stdout/stderr. Use for running programs, installing packages, git operations, network requests, etc.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (default: current directory)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['command'],
  },
};

const readFileTool: ToolDef = {
  name: 'read_file',
  description:
    'Read the contents of a file at the given path. Supports reading specific line ranges for large files.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
      offset: {
        type: 'number',
        description: 'Starting line number (1-indexed). If omitted, reads from the beginning.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read. If omitted, reads to end of file.',
      },
    },
    required: ['path'],
  },
};

const writeFileTool: ToolDef = {
  name: 'write_file',
  description:
    'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
    },
    required: ['path', 'content'],
  },
};

const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    'Edit a file by replacing exact text. The old_text must match exactly (including whitespace). Use for precise, surgical edits.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
      old_text: {
        type: 'string',
        description: 'Exact text to find and replace (must match exactly)',
      },
      new_text: {
        type: 'string',
        description: 'New text to replace the old text with',
      },
    },
    required: ['path', 'old_text', 'new_text'],
  },
};

const listFilesTool: ToolDef = {
  name: 'list_files',
  description:
    'List files and directories at a given path. Returns names with trailing / for directories.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list (default: current directory)',
      },
    },
    required: [],
  },
};

const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Search for a pattern in files. Uses grep -rn under the hood. Returns matching lines with file paths and line numbers.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern (basic regex)',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in (default: current directory)',
      },
      include: {
        type: 'string',
        description: 'File glob pattern to include (e.g. "*.ts")',
      },
    },
    required: ['pattern'],
  },
};

const globTool: ToolDef = {
  name: 'glob',
  description:
    'Find files matching a glob pattern recursively. Skips node_modules, .git, dist, ' +
    '__pycache__, .next, build, coverage by default. Use for finding files by name or extension ' +
    'across a project. More powerful than list_files for searching.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pattern: {
        type: 'string',
        description: 'File name pattern (e.g. "*.ts", "*.test.*", "package.json", "Dockerfile")',
      },
      path: {
        type: 'string',
        description: 'Root directory to search from (default: current directory)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 200)',
      },
    },
    required: ['pattern'],
  },
};

const spawnAgentTool: ToolDef = {
  name: 'spawn_agent',
  description:
    'Spawn a sub-agent to work on a task independently. The sub-agent gets its own conversation ' +
    'with full tool access (exec, read, write, edit, grep, list_files) and runs until the task is ' +
    'complete or it hits the iteration limit. Use this for: complex tasks you want to delegate, ' +
    'parallel research, reviewing code while you work on something else, or any task that benefits ' +
    'from a fresh context. The sub-agent shares your workspace and filesystem.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: {
        type: 'string',
        description: 'Clear description of what the sub-agent should do. Be specific.',
      },
      context: {
        type: 'string',
        description: 'Optional context to provide (e.g. relevant file paths, decisions made, constraints)',
      },
      model: {
        type: 'string',
        description: 'Model to use (default: same as parent). Use a smaller model for simple tasks.',
      },
      max_iterations: {
        type: 'number',
        description: 'Maximum tool-use iterations (default: 15, max: 25)',
      },
    },
    required: ['task'],
  },
};

const fetchTool: ToolDef = {
  name: 'fetch',
  description:
    'Fetch a URL and return the response. Supports HTTP/HTTPS. Returns headers and body. ' +
    'For HTML pages, can optionally extract just the text content (strips tags). ' +
    'Use for: reading web pages, calling APIs, downloading data.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch',
      },
      method: {
        type: 'string',
        description: 'HTTP method (default: GET)',
      },
      headers: {
        type: 'object',
        description: 'Request headers as key-value pairs',
      },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT/PATCH)',
      },
      text_only: {
        type: 'boolean',
        description: 'Strip HTML tags and return plain text (default: false)',
      },
      max_bytes: {
        type: 'number',
        description: 'Maximum response size in bytes (default: 100000)',
      },
    },
    required: ['url'],
  },
};

const treeTool: ToolDef = {
  name: 'tree',
  description:
    'Show directory structure as a tree. Like the `tree` command but built-in. ' +
    'Respects .gitignore patterns and skips node_modules/dist/.git by default.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Root directory (default: current directory)',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum depth to recurse (default: 4)',
      },
      include_hidden: {
        type: 'boolean',
        description: 'Include hidden files/directories (default: false)',
      },
    },
    required: [],
  },
};

const patchTool: ToolDef = {
  name: 'patch',
  description:
    'Apply multiple edits to a file in one operation. More efficient than multiple edit_file calls. ' +
    'Each edit is a find-replace pair applied in order.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      edits: {
        type: 'array',
        description: 'Array of {old_text, new_text} pairs to apply in order',
        items: {
          type: 'object',
          properties: {
            old_text: { type: 'string', description: 'Exact text to find' },
            new_text: { type: 'string', description: 'Replacement text' },
          },
          required: ['old_text', 'new_text'],
        },
      },
    },
    required: ['path', 'edits'],
  },
};

const internalTools = [
  execTool, readFileTool, writeFileTool, editFileTool, listFilesTool, grepTool,
  globTool, fetchTool, treeTool, patchTool, spawnAgentTool,
];

/**
 * Get tool definitions, optionally mapped to Claude Code names for OAT auth.
 */
export function getToolDefinitions(useClaudeCodeNames: boolean): ToolDef[] {
  if (!useClaudeCodeNames) {
    return internalTools;
  }

  return internalTools.map((tool) => ({
    ...tool,
    name: toClaudeCodeName(tool.name),
  }));
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
interface SpawnAgentInput { task: string; context?: string; model?: string; max_iterations?: number }

type ToolInput = ExecInput | ReadFileInput | WriteFileInput | EditFileInput | ListFilesInput | GrepInput | GlobInput | FetchInput | TreeInput | PatchInput | SpawnAgentInput;

/**
 * Produce a short human-readable summary of a tool call for display.
 */
export function summarizeToolCall(name: string, input: ToolInput, isOAuth: boolean): string {
  const internalName = isOAuth ? fromClaudeCodeName(name) : name;
  switch (internalName) {
    case 'exec': {
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
    case 'fetch': {
      const { url, method } = input as FetchInput;
      return `${(method ?? 'GET').toUpperCase()} ${url.length > 60 ? url.slice(0, 60) + '...' : url}`;
    }
    case 'tree':
      return `tree ${(input as TreeInput).path ?? '.'}`;
    case 'patch':
      return `patch ${(input as PatchInput).path} (${(input as PatchInput).edits?.length ?? 0} edits)`;
    case 'spawn_agent': {
      const { task } = input as SpawnAgentInput;
      const short = task.length > 60 ? task.slice(0, 60) + '...' : task;
      return `spawn: ${short}`;
    }
    default:
      return name;
  }
}

// --- Tool Execution ---

/**
 * Execute a tool and return the result.
 * For exec, output is streamed via onOutput callback if provided.
 */
export async function executeTool(
  name: string,
  input: ToolInput,
  isOAuth: boolean,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  // Map Claude Code names back to internal names if needed
  const internalName = isOAuth ? fromClaudeCodeName(name) : name;

  switch (internalName) {
    case 'exec': {
      const { command, cwd, timeout = 30_000 } = input as ExecInput;
      return new Promise<string>((res) => {
        let stdout = '';
        let stderr = '';

        const proc = spawn('sh', ['-c', command], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
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

    case 'read_file': {
      const { path, offset, limit } = input as ReadFileInput;
      try {
        const content = readFileSync(path, 'utf-8');
        if (!offset && !limit) return content;

        const lines = content.split('\n');
        const start = Math.max(0, (offset ?? 1) - 1); // Convert 1-indexed to 0-indexed
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
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf-8');
        return `Wrote ${content.length} bytes to ${path}`;
      } catch (err: unknown) {
        const fsErr = err as { message?: string };
        return `Error writing file: ${fsErr.message ?? 'unknown error'}`;
      }
    }

    case 'edit_file': {
      const { path, old_text, new_text } = input as EditFileInput;
      try {
        const content = readFileSync(path, 'utf-8');
        const index = content.indexOf(old_text);
        if (index === -1) {
          return `Error: old_text not found in ${path}. Make sure it matches exactly (including whitespace).`;
        }
        // Check for multiple matches
        const secondIndex = content.indexOf(old_text, index + 1);
        if (secondIndex !== -1) {
          return `Error: old_text appears multiple times in ${path}. Use a more specific match.`;
        }
        const newContent = content.slice(0, index) + new_text + content.slice(index + old_text.length);
        writeFileSync(path, newContent, 'utf-8');
        return `Edited ${path}`;
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
        return entries
          .map((entry) => {
            try {
              const stat = statSync(resolve(resolved, entry));
              return stat.isDirectory() ? `${entry}/` : entry;
            } catch {
              return entry;
            }
          })
          .join('\n');
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
          encoding: 'utf-8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output || '(no matches)';
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; status?: number };
        if (execErr.status === 1) {
          return '(no matches)';
        }
        return `Error: ${(err as { message?: string }).message ?? 'unknown error'}`;
      }
    }

    case 'fetch': {
      const { url, method = 'GET', headers: reqHeaders, body: reqBody, text_only = false, max_bytes = 100_000 } = input as FetchInput;
      try {
        const args: string[] = ['-sS', '-L', '--max-time', '30', '--max-filesize', String(max_bytes)];
        args.push('-X', method.toUpperCase());
        args.push('-D', '-'); // dump headers to stdout
        if (reqHeaders) {
          for (const [k, v] of Object.entries(reqHeaders)) {
            args.push('-H', `${k}: ${v}`);
          }
        }
        if (reqBody) {
          args.push('-d', reqBody);
        }
        args.push(url);

        const raw = execSync(`curl ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
          encoding: 'utf-8',
          timeout: 35_000,
          maxBuffer: max_bytes + 10_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (text_only) {
          // Strip HTML tags, decode entities, collapse whitespace
          const bodyStart = raw.indexOf('\r\n\r\n');
          const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;
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

        return raw || '(empty response)';
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
        try {
          entries = readdirSync(resolve(dir)).sort();
        } catch {
          return;
        }

        if (!include_hidden) {
          entries = entries.filter((e) => !e.startsWith('.'));
        }
        entries = entries.filter((e) => !SKIP_DIRS.has(e));

        // Cap entries to avoid huge output
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
            if (stat.isDirectory()) {
              dirCount++;
              lines.push(`${prefix}${connector}${entry}/`);
              walk(fullPath, prefix + childPrefix, depth + 1);
            } else {
              fileCount++;
              lines.push(`${prefix}${connector}${entry}`);
            }
          } catch {
            lines.push(`${prefix}${connector}${entry} [error]`);
          }
        }

        if (truncated) {
          lines.push(`${prefix}\u2514\u2500\u2500 ... (${entries.length - maxEntries} more)`);
        }
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
        // Use find with -name for pattern matching, pruning common noise dirs
        const cmd = `find ${JSON.stringify(resolve(rootPath))} \\( ${pruneArgs} \\) -o -name ${JSON.stringify(pattern)} -print | head -n ${max_results}`;
        const output = execSync(cmd, {
          encoding: 'utf-8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
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
      if (!edits || edits.length === 0) {
        return 'Error: no edits provided';
      }
      try {
        let content = readFileSync(filePath, 'utf-8');
        const applied: string[] = [];
        const failed: string[] = [];

        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i]!;
          const idx = content.indexOf(edit.old_text);
          if (idx === -1) {
            failed.push(`Edit ${i + 1}: old_text not found`);
            continue;
          }
          const secondIdx = content.indexOf(edit.old_text, idx + 1);
          if (secondIdx !== -1) {
            failed.push(`Edit ${i + 1}: old_text appears multiple times`);
            continue;
          }
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

    default:
      return `Unknown tool: ${name} (internal: ${internalName})`;
  }
}
