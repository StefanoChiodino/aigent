import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProvider,
  _convertMessagesForAnthropicTest,
  _convertMessagesForOpenAITest,
  type ProviderMessage,
} from './provider.js';

describe('detectProvider', () => {
  const origEnv: Record<string, string | undefined> = {};
  const envKeys = ['AIGENT_PROVIDER', 'AIGENT_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

  beforeEach(() => {
    for (const key of envKeys) {
      origEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (origEnv[key] !== undefined) {
        process.env[key] = origEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns openai when AIGENT_PROVIDER=openai', () => {
    process.env['AIGENT_PROVIDER'] = 'openai';
    assert.equal(detectProvider(), 'openai');
  });

  it('returns anthropic when AIGENT_PROVIDER=anthropic', () => {
    process.env['AIGENT_PROVIDER'] = 'anthropic';
    assert.equal(detectProvider(), 'anthropic');
  });

  it('returns openai when AIGENT_BASE_URL is set', () => {
    process.env['AIGENT_BASE_URL'] = 'http://localhost:11434/v1';
    assert.equal(detectProvider(), 'openai');
  });

  it('returns openai when only OPENAI_API_KEY is set', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    assert.equal(detectProvider(), 'openai');
  });

  it('returns anthropic when both keys are set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    assert.equal(detectProvider(), 'anthropic');
  });

  it('returns anthropic as default', () => {
    assert.equal(detectProvider(), 'anthropic');
  });

  it('explicit AIGENT_PROVIDER overrides key detection', () => {
    process.env['AIGENT_PROVIDER'] = 'anthropic';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    assert.equal(detectProvider(), 'anthropic');
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider message conversion
// ---------------------------------------------------------------------------

describe('AnthropicProvider.convertMessages', () => {
  it('converts a simple user string message', () => {
    const msgs: ProviderMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = _convertMessagesForAnthropicTest(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.role, 'user');
  });

  it('converts an assistant message with text', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there', toolCalls: [] },
    ];
    const result = _convertMessagesForAnthropicTest(msgs);
    assert.equal(result.length, 2);
    assert.equal(result[1]!.role, 'assistant');
    const content = result[1]!.content as Array<{ type: string; text?: string }>;
    assert.ok(content.some((b) => b.type === 'text' && b.text === 'Hi there'));
  });

  it('includes tool_use blocks for assistant tool calls', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'exec', input: { command: 'ls' } }],
      },
    ];
    const result = _convertMessagesForAnthropicTest(msgs);
    const assistantContent = result[1]!.content as Array<{ type: string; name?: string }>;
    assert.ok(assistantContent.some((b) => b.type === 'tool_use' && b.name === 'exec'));
  });

  it('converts tool_result to user role', () => {
    const msgs: ProviderMessage[] = [
      {
        role: 'tool_result',
        results: [{ id: 'tc_1', content: 'output text' }],
      },
    ];
    const result = _convertMessagesForAnthropicTest(msgs);
    assert.equal(result[0]!.role, 'user');
    const content = result[0]!.content as Array<{ type: string; tool_use_id?: string }>;
    assert.ok(content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tc_1'));
  });

  it('attaches cache_control to last 2 user messages (non-OAuth)', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'msg 1' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'msg 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'msg 3' },
    ];
    const result = _convertMessagesForAnthropicTest(msgs, false);

    // Last 2 user messages should have cache_control on their last content block
    const userMsgs = result.filter((m) => m.role === 'user');
    const lastTwo = userMsgs.slice(-2);
    for (const m of lastTwo) {
      const blocks = m.content as Array<Record<string, unknown>>;
      const lastBlock = blocks[blocks.length - 1]!;
      assert.ok('cache_control' in lastBlock, `Expected cache_control on block: ${JSON.stringify(lastBlock)}`);
    }
  });

  it('attaches cache_control to only the last user message (OAuth)', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'msg 1' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'msg 2' },
    ];
    const result = _convertMessagesForAnthropicTest(msgs, true);

    const userMsgs = result.filter((m) => m.role === 'user');

    // Only the last user message should get cache_control
    const last = userMsgs[userMsgs.length - 1]!;
    const lastBlocks = last.content as Array<Record<string, unknown>>;
    assert.ok('cache_control' in lastBlocks[lastBlocks.length - 1]!);

    // Earlier user message must NOT have cache_control — it stays as a plain string
    const first = userMsgs[0]!;
    // String content means it was never promoted to array form (no cache_control added)
    assert.ok(typeof first.content === 'string', 'First user message should remain a string (no cache_control)');
    assert.equal(first.content, 'msg 1');
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider message conversion
// ---------------------------------------------------------------------------

describe('OpenAIProvider.convertMessages', () => {
  it('prepends a system message', () => {
    const result = _convertMessagesForOpenAITest('You are a helpful assistant.', []) as Array<Record<string, unknown>>;
    assert.equal(result.length, 1);
    assert.equal(result[0]!['role'], 'system');
    assert.equal(result[0]!['content'], 'You are a helpful assistant.');
  });

  it('converts user string message', () => {
    const msgs: ProviderMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = _convertMessagesForOpenAITest('sys', msgs) as Array<Record<string, unknown>>;
    assert.equal(result.length, 2);
    assert.equal(result[1]!['role'], 'user');
    assert.equal(result[1]!['content'], 'Hello');
  });

  it('converts assistant message with tool calls', () => {
    const msgs: ProviderMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'exec', input: { command: 'ls' } }],
      },
    ];
    const result = _convertMessagesForOpenAITest('sys', msgs) as Array<Record<string, unknown>>;
    const assistant = result[1]!;
    assert.equal(assistant['role'], 'assistant');
    const tcs = assistant['tool_calls'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tcs) && tcs.length === 1);
    assert.equal((tcs[0]!['function'] as Record<string, unknown>)['name'], 'exec');
  });

  it('converts tool_result to tool role entries', () => {
    const msgs: ProviderMessage[] = [
      {
        role: 'tool_result',
        results: [
          { id: 'tc_1', content: 'output A' },
          { id: 'tc_2', content: 'output B' },
        ],
      },
    ];
    const result = _convertMessagesForOpenAITest('sys', msgs) as Array<Record<string, unknown>>;
    // 1 system + 2 tool results
    assert.equal(result.length, 3);
    assert.equal(result[1]!['role'], 'tool');
    assert.equal(result[1]!['tool_call_id'], 'tc_1');
    assert.equal(result[2]!['role'], 'tool');
    assert.equal(result[2]!['tool_call_id'], 'tc_2');
  });

  it('represents PDF document as text placeholder for OpenAI', () => {
    const msgs: ProviderMessage[] = [
      {
        role: 'user',
        content: [{
          type: 'document',
          mediaType: 'application/pdf',
          data: 'base64data',
          title: 'report.pdf',
        }],
      },
    ];
    const result = _convertMessagesForOpenAITest('sys', msgs) as Array<Record<string, unknown>>;
    const parts = result[1]!['content'] as Array<Record<string, unknown>>;
    assert.equal(parts[0]!['type'], 'text');
    assert.ok((parts[0]!['text'] as string).includes('report.pdf'));
  });

  it('converts image content to image_url for OpenAI', () => {
    const msgs: ProviderMessage[] = [
      {
        role: 'user',
        content: [{
          type: 'image',
          mediaType: 'image/png',
          data: 'base64imgdata',
        }],
      },
    ];
    const result = _convertMessagesForOpenAITest('sys', msgs) as Array<Record<string, unknown>>;
    const parts = result[1]!['content'] as Array<Record<string, unknown>>;
    assert.equal(parts[0]!['type'], 'image_url');
    const url = (parts[0]!['image_url'] as Record<string, unknown>)['url'] as string;
    assert.ok(url.startsWith('data:image/png;base64,'));
  });
});
