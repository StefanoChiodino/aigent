import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

// Tool definitions for the Claude API
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'exec',
    description:
      'Execute a shell command and return stdout/stderr. Use for running programs, installing packages, git operations, etc.',
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
  },
  {
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
  },
  {
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
  },
];

interface ExecInput {
  command: string;
  timeout?: number;
}

interface ReadFileInput {
  path: string;
}

interface WriteFileInput {
  path: string;
  content: string;
}

type ToolInput = ExecInput | ReadFileInput | WriteFileInput;

export function executeTool(name: string, input: ToolInput): string {
  switch (name) {
    case 'exec': {
      const { command, timeout = 30_000 } = input as ExecInput;
      try {
        const output = execSync(command, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024, // 1MB
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output;
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; status?: number };
        const stdout = execErr.stdout ?? '';
        const stderr = execErr.stderr ?? '';
        const code = execErr.status ?? 1;
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

    default:
      return `Unknown tool: ${name}`;
  }
}
