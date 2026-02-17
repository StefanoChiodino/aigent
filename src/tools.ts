import { execSync } from 'node:child_process';
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
 */
const CLAUDE_CODE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
] as const;

const CC_NAME_MAP = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

export function toClaudeCodeName(name: string): string {
  return CC_NAME_MAP.get(name.toLowerCase()) ?? name;
}

export function fromClaudeCodeName(name: string): string {
  const lower = name.toLowerCase();
  // Map CC names back to our internal names
  switch (lower) {
    case 'bash': return 'exec';
    case 'read': return 'read_file';
    case 'write': return 'write_file';
    case 'edit': return 'edit_file';
    case 'grep': return 'grep';
    case 'glob': return 'list_files';
    default: return name;
  }
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
  description: 'Read the contents of a file at the given path.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
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

const internalTools = [execTool, readFileTool, writeFileTool, editFileTool, listFilesTool, grepTool];

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

interface ExecInput { command: string; timeout?: number }
interface ReadFileInput { path: string }
interface WriteFileInput { path: string; content: string }
interface EditFileInput { path: string; old_text: string; new_text: string }
interface ListFilesInput { path?: string }
interface GrepInput { pattern: string; path?: string; include?: string }

type ToolInput = ExecInput | ReadFileInput | WriteFileInput | EditFileInput | ListFilesInput | GrepInput;

/**
 * Produce a short human-readable summary of a tool call for display.
 */
export function summarizeToolCall(name: string, input: ToolInput, isOAuth: boolean): string {
  const internalName = isOAuth ? fromClaudeCodeName(name) : name;
  switch (internalName) {
    case 'exec': {
      const { command } = input as ExecInput;
      const short = command.length > 80 ? command.slice(0, 80) + '...' : command;
      return `$ ${short}`;
    }
    case 'read_file':
      return `read ${(input as ReadFileInput).path}`;
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
    default:
      return name;
  }
}

// --- Tool Execution ---

export function executeTool(name: string, input: ToolInput, isOAuth: boolean): string {
  // Map Claude Code names back to internal names if needed
  const internalName = isOAuth ? fromClaudeCodeName(name) : name;

  switch (internalName) {
    case 'exec': {
      const { command, timeout = 30_000 } = input as ExecInput;
      try {
        const output = execSync(command, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024 * 5, // 5MB
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output || '(no output)';
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
        const stdout = execErr.stdout ?? '';
        const stderr = execErr.stderr ?? '';
        const code = execErr.status ?? 1;
        if (!stdout && !stderr) {
          return `Exit code: ${code}\n${execErr.message ?? 'unknown error'}`.trim();
        }
        return `Exit code: ${code}\n${stdout}\n${stderr}`.trim();
      }
    }

    case 'read_file': {
      const { path } = input as ReadFileInput;
      try {
        return readFileSync(path, 'utf-8');
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

    default:
      return `Unknown tool: ${name} (internal: ${internalName})`;
  }
}
