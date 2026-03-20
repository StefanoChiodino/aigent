/**
 * Unit tests for src/tools.ts — curl parsing, name mapping, tool definitions, summarization.
 * Run with: node --import tsx/esm --test src/tools.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCurlResponse,
  toClaudeCodeName,
  fromClaudeCodeName,
  getToolDefinitions,
  summarizeToolCall,
} from './tools.js';

// ---------------------------------------------------------------------------
// parseCurlResponse
// ---------------------------------------------------------------------------

describe('parseCurlResponse', () => {
  const SINGLE_RESPONSE =
    'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n<html><body><h1>Hello</h1></body></html>';

  const REDIRECT_RESPONSE =
    'HTTP/2 308\r\nlocation: https://www.example.com/\r\n\r\n' +
    'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
    '<html><body><p>Final page</p></body></html>';

  const DOUBLE_REDIRECT =
    'HTTP/2 301\r\nlocation: https://example.com/a\r\n\r\n' +
    'HTTP/2 302\r\nlocation: https://example.com/b\r\n\r\n' +
    'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
    '<html><body>Done</body></html>';

  it('extracts body from single response', () => {
    const result = parseCurlResponse(SINGLE_RESPONSE, false);
    assert.equal(result, '<html><body><h1>Hello</h1></body></html>');
  });

  it('extracts body from redirect response (skips intermediate headers)', () => {
    const result = parseCurlResponse(REDIRECT_RESPONSE, false);
    assert.equal(result, '<html><body><p>Final page</p></body></html>');
  });

  it('extracts body from double redirect', () => {
    const result = parseCurlResponse(DOUBLE_REDIRECT, false);
    assert.equal(result, '<html><body>Done</body></html>');
  });

  it('strips HTML in text_only mode', () => {
    const result = parseCurlResponse(SINGLE_RESPONSE, true);
    assert.equal(result, 'Hello');
  });

  it('strips HTML in text_only mode after redirect', () => {
    const result = parseCurlResponse(REDIRECT_RESPONSE, true);
    assert.equal(result, 'Final page');
    // Must NOT contain HTTP headers in the text output
    assert.ok(!result.includes('HTTP/2'), 'should not contain HTTP headers');
    assert.ok(!result.includes('content-type'), 'should not contain header fields');
  });

  it('strips scripts and styles in text_only mode', () => {
    const raw =
      'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
      '<html><head><script>var x=1;</script><style>body{color:red}</style></head>' +
      '<body><p>Content here</p></body></html>';
    const result = parseCurlResponse(raw, true);
    assert.equal(result, 'Content here');
    assert.ok(!result.includes('var x'), 'should strip script content');
    assert.ok(!result.includes('color:red'), 'should strip style content');
  });

  it('decodes HTML entities in text_only mode', () => {
    const raw =
      'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
      '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39; &nbsp;G</p>';
    const result = parseCurlResponse(raw, true);
    assert.equal(result, 'A & B < C > D "E" \'F\' G');
  });

  it('returns raw body when no headers present', () => {
    const result = parseCurlResponse('just plain text', false);
    assert.equal(result, 'just plain text');
  });

  it('returns (empty response) for empty body after headers', () => {
    const raw = 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n';
    const result = parseCurlResponse(raw, false);
    assert.equal(result, '(empty response)');
  });

  it('returns (empty response) for whitespace-only body in text_only mode', () => {
    const raw = 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n   \n  \t  ';
    const result = parseCurlResponse(raw, true);
    assert.equal(result, '(empty response)');
  });
});

// ---------------------------------------------------------------------------
// toClaudeCodeName / fromClaudeCodeName
// ---------------------------------------------------------------------------

describe('toClaudeCodeName', () => {
  it('maps exec → Bash', () => assert.equal(toClaudeCodeName('exec'), 'Bash'));
  it('maps read_file → Read', () => assert.equal(toClaudeCodeName('read_file'), 'Read'));
  it('maps write_file → Write', () => assert.equal(toClaudeCodeName('write_file'), 'Write'));
  it('maps edit_file → Edit', () => assert.equal(toClaudeCodeName('edit_file'), 'Edit'));
  it('maps grep → Grep', () => assert.equal(toClaudeCodeName('grep'), 'Grep'));
  it('maps glob → Glob', () => assert.equal(toClaudeCodeName('glob'), 'Glob'));
  it('passes through unmapped names', () => assert.equal(toClaudeCodeName('fetch'), 'fetch'));
  it('passes through dispatch_task', () => assert.equal(toClaudeCodeName('dispatch_task'), 'dispatch_task'));
});

describe('fromClaudeCodeName', () => {
  it('maps Bash → exec (case-insensitive)', () => assert.equal(fromClaudeCodeName('Bash'), 'exec'));
  it('maps bash → exec', () => assert.equal(fromClaudeCodeName('bash'), 'exec'));
  it('maps Read → read_file', () => assert.equal(fromClaudeCodeName('Read'), 'read_file'));
  it('maps Write → write_file', () => assert.equal(fromClaudeCodeName('Write'), 'write_file'));
  it('maps Edit → edit_file', () => assert.equal(fromClaudeCodeName('Edit'), 'edit_file'));
  it('maps Grep → grep', () => assert.equal(fromClaudeCodeName('Grep'), 'grep'));
  it('maps Glob → glob', () => assert.equal(fromClaudeCodeName('Glob'), 'glob'));
  it('passes through unmapped names', () => assert.equal(fromClaudeCodeName('fetch'), 'fetch'));
});

// ---------------------------------------------------------------------------
// getToolDefinitions
// ---------------------------------------------------------------------------

describe('getToolDefinitions', () => {
  it('returns 28 tools with internal names', () => {
    const tools = getToolDefinitions(false);
    assert.equal(tools.length, 27);
  });

  it('returns 28 tools with CC names', () => {
    const tools = getToolDefinitions(true);
    assert.equal(tools.length, 27);
  });

  it('internal names include exec, read_file, write_file, compact_context', () => {
    const names = getToolDefinitions(false).map((t) => t.name);
    assert.ok(names.includes('exec'));
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('compact_context'));
    assert.ok(!names.includes('speak_text'), 'speak_text was removed — TTS is post-hoc');
  });

  it('CC names include Bash, Read, Write', () => {
    const names = getToolDefinitions(true).map((t) => t.name);
    assert.ok(names.includes('Bash'));
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Write'));
  });

  it('every tool has name, description, and input_schema', () => {
    for (const tool of getToolDefinitions(false)) {
      assert.ok(tool.name, `tool should have a name`);
      assert.ok(tool.description, `${tool.name} should have a description`);
      assert.equal(tool.input_schema.type, 'object', `${tool.name} schema should be object`);
    }
  });

  it('unmapped tools keep their name in CC mode', () => {
    const internal = getToolDefinitions(false).map((t) => t.name);
    const cc = getToolDefinitions(true).map((t) => t.name);
    // fetch has no CC mapping, should stay the same
    assert.ok(internal.includes('fetch'));
    assert.ok(cc.includes('fetch'));
  });
});

// ---------------------------------------------------------------------------
// summarizeToolCall
// ---------------------------------------------------------------------------

describe('summarizeToolCall', () => {
  it('exec: "$ command"', () => {
    assert.equal(summarizeToolCall('exec', { command: 'ls -la' }, false), '$ ls -la');
  });

  it('exec: truncates long commands to 80 chars', () => {
    const long = 'a'.repeat(100);
    const result = summarizeToolCall('exec', { command: long }, false);
    assert.equal(result, `$ ${'a'.repeat(80)}...`);
  });

  it('exec with cwd: includes directory', () => {
    const result = summarizeToolCall('exec', { command: 'ls', cwd: '/tmp' }, false);
    assert.equal(result, '$ ls (in /tmp)');
  });

  it('read_file: "read path"', () => {
    assert.equal(summarizeToolCall('read_file', { path: 'foo.ts' }, false), 'read foo.ts');
  });

  it('read_file with offset+limit: includes range', () => {
    const result = summarizeToolCall('read_file', { path: 'foo.ts', offset: 10, limit: 50 }, false);
    assert.equal(result, 'read foo.ts [10:+50]');
  });

  it('write_file: "write path (N lines)"', () => {
    const result = summarizeToolCall('write_file', { path: 'out.txt', content: 'a\nb\nc' }, false);
    assert.equal(result, 'write out.txt (3 lines)');
  });

  it('edit_file: "edit path"', () => {
    assert.equal(
      summarizeToolCall('edit_file', { path: 'x.ts', old_text: 'a', new_text: 'b' }, false),
      'edit x.ts',
    );
  });

  it('list_files: "ls ." by default', () => {
    assert.equal(summarizeToolCall('list_files', {}, false), 'ls .');
  });

  it('list_files with path', () => {
    assert.equal(summarizeToolCall('list_files', { path: '/src' }, false), 'ls /src');
  });

  it('grep: includes pattern and path', () => {
    assert.equal(summarizeToolCall('grep', { pattern: 'TODO' }, false), 'grep "TODO" .');
  });

  it('glob: includes pattern and path', () => {
    assert.equal(summarizeToolCall('glob', { pattern: '*.ts' }, false), 'glob "*.ts" .');
  });

  it('fetch: "GET url"', () => {
    assert.equal(
      summarizeToolCall('fetch', { url: 'https://example.com' }, false),
      'GET https://example.com',
    );
  });

  it('fetch with method: "POST url"', () => {
    assert.equal(
      summarizeToolCall('fetch', { url: 'https://api.com/data', method: 'post' }, false),
      'POST https://api.com/data',
    );
  });

  it('fetch truncates long URLs to 60 chars', () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(60);
    const result = summarizeToolCall('fetch', { url: longUrl }, false);
    assert.ok(result.endsWith('...'));
    // "GET " prefix + 60 chars + "..."
    assert.ok(result.length <= 68);
  });

  it('tree: "tree ." by default', () => {
    assert.equal(summarizeToolCall('tree', {}, false), 'tree .');
  });

  it('patch: "patch path (N edits)"', () => {
    const edits = [{ old_text: 'a', new_text: 'b' }, { old_text: 'c', new_text: 'd' }];
    assert.equal(summarizeToolCall('patch', { path: 'f.ts', edits }, false), 'patch f.ts (2 edits)');
  });

  it('screenshot: "screenshot"', () => {
    assert.equal(summarizeToolCall('screenshot', {}, false), 'screenshot');
  });

  it('screenshot with region', () => {
    assert.equal(summarizeToolCall('screenshot', { region: '0,0,100,100' }, false), 'screenshot (0,0,100,100)');
  });

  it('spawn_agent: truncates long task', () => {
    const task = 'a'.repeat(80);
    const result = summarizeToolCall('spawn_agent', { task }, false);
    assert.ok(result.startsWith('spawn: '));
    assert.ok(result.endsWith('...'));
  });

  it('dispatch_task: "dispatch: task"', () => {
    assert.equal(summarizeToolCall('dispatch_task', { task: 'do stuff' }, false), 'dispatch: do stuff');
  });

  it('host: "host: capability"', () => {
    assert.equal(summarizeToolCall('host', { capability: 'clipboard' }, false), 'host: clipboard');
  });

  it('host with reason', () => {
    const result = summarizeToolCall('host', { capability: 'audio', reason: 'play a sound' }, false);
    assert.equal(result, 'host: audio (play a sound)');
  });

  it('request_config_write: "config write: file"', () => {
    assert.equal(
      summarizeToolCall('request_config_write', { file: 'SOUL.md', content: '...', reason: '...' }, false),
      'config write: SOUL.md',
    );
  });

  it('switch_model: "switch model → name"', () => {
    assert.equal(
      summarizeToolCall('switch_model', { model: 'haiku' }, false),
      'switch model → haiku',
    );
  });

  it('search_memory: includes query', () => {
    assert.equal(
      summarizeToolCall('search_memory', { query: 'API keys' } as never, false),
      'search memory: "API keys"',
    );
  });

  it('request_screenshot: "screenshot from browser"', () => {
    assert.equal(summarizeToolCall('request_screenshot', {}, false), 'screenshot from browser');
  });

  it('browser_ext activate_tab', () => {
    assert.equal(
      summarizeToolCall('browser_ext', { action: 'activate_tab', tabId: 5 }, false),
      'browser: activate tab 5',
    );
  });

  it('browser_ext extract_a11y with selector', () => {
    assert.equal(
      summarizeToolCall('browser_ext', { action: 'extract_a11y', rootSelector: '#main' }, false),
      'browser: extract_a11y (#main)',
    );
  });

  it('browser_ext open_tab with url', () => {
    assert.equal(
      summarizeToolCall('browser_ext', { action: 'open_tab', url: 'https://x.com' }, false),
      'browser: open tab → https://x.com',
    );
  });

  it('handles CC names when isOAuth=true', () => {
    // 'Bash' should be translated to 'exec' internally
    assert.equal(summarizeToolCall('Bash', { command: 'pwd' }, true), '$ pwd');
  });

  it('host_edit_file: "edit path (N edit)"', () => {
    assert.equal(
      summarizeToolCall('host_edit_file', { path: 'src/foo.ts', edits: [{ old_str: 'a', new_str: 'b' }] }, false),
      'edit src/foo.ts (1 edit)',
    );
  });

  it('host_edit_file: plural edits', () => {
    const edits = [{ old_str: 'a', new_str: 'b' }, { old_str: 'c', new_str: 'd' }];
    assert.equal(
      summarizeToolCall('host_edit_file', { path: 'foo.ts', edits }, false),
      'edit foo.ts (2 edits)',
    );
  });

  it('host_edit_file: zero edits', () => {
    assert.equal(
      summarizeToolCall('host_edit_file', { path: 'foo.ts', edits: [] }, false),
      'edit foo.ts (0 edits)',
    );
  });

  it('ask_user: shows question as summary', () => {
    assert.equal(
      summarizeToolCall('ask_user', { question: 'What color?' }, false),
      'ask: What color?',
    );
  });

  it('ask_user: truncates long questions to 60 chars', () => {
    const long = 'x'.repeat(80);
    const result = summarizeToolCall('ask_user', { question: long }, false);
    assert.ok(result.startsWith('ask: '));
    assert.ok(result.endsWith('...'));
    // "ask: " + 60 chars + "..."
    assert.ok(result.length <= 68);
  });

  it('compact_context: "compact context"', () => {
    assert.equal(summarizeToolCall('compact_context', {}, false), 'compact context');
  });


  it('unknown tool returns raw name', () => {
    assert.equal(summarizeToolCall('nonexistent_tool', {}, false), 'nonexistent_tool');
  });
});
