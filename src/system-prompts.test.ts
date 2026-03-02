/**
 * System prompt builders — tests for host daemon prompt, browser extension
 * prompt, short mode prompt, and extractAndStripSpeak.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostSystemPrompt, buildBrowserExtSystemPrompt, extractAndStripSpeak, SHORT_MODE_PROMPT } from './system-prompts.js';

function mockHostClient(opts: {
  connected?: boolean;
  available?: string[];
  denied?: string[];
} = {}) {
  return {
    isConnected: () => opts.connected ?? true,
    getAvailableCapabilities: () => opts.available ?? [],
    getDeniedCapabilities: () => opts.denied ?? [],
  } as Parameters<typeof buildHostSystemPrompt>[0];
}

describe('buildHostSystemPrompt', () => {
  it('returns empty string when hostClient is null', () => {
    assert.equal(buildHostSystemPrompt(null), '');
  });

  it('returns empty string when not connected', () => {
    assert.equal(buildHostSystemPrompt(mockHostClient({ connected: false })), '');
  });

  it('returns empty string when no capabilities', () => {
    assert.equal(buildHostSystemPrompt(mockHostClient({ available: [], denied: [] })), '');
  });

  it('includes available capabilities', () => {
    const result = buildHostSystemPrompt(mockHostClient({ available: ['clipboard', 'audio'] }));
    assert.ok(result.includes('clipboard, audio'));
    assert.ok(result.includes('Host Daemon'));
  });

  it('includes denied capabilities', () => {
    const result = buildHostSystemPrompt(mockHostClient({ denied: ['notifications'] }));
    assert.ok(result.includes('Denied: notifications'));
  });

  it('includes both available and denied', () => {
    const result = buildHostSystemPrompt(mockHostClient({
      available: ['clipboard'],
      denied: ['audio'],
    }));
    assert.ok(result.includes('Available: clipboard'));
    assert.ok(result.includes('Denied: audio'));
  });
});

describe('buildBrowserExtSystemPrompt', () => {
  it('returns empty string when not connected', () => {
    assert.equal(buildBrowserExtSystemPrompt(false), '');
  });

  it('returns prompt with instructions when connected', () => {
    const result = buildBrowserExtSystemPrompt(true);
    assert.ok(result.includes('Browser Extension (connected)'));
    assert.ok(result.includes('browser_ext'));
  });

  it('includes security warning about untrusted content', () => {
    const result = buildBrowserExtSystemPrompt(true);
    assert.ok(result.includes('CRITICAL SECURITY RULE'));
    assert.ok(result.includes('UNTRUSTED DATA'));
  });

  it('documents read-only and write actions', () => {
    const result = buildBrowserExtSystemPrompt(true);
    assert.ok(result.includes('list_tabs'));
    assert.ok(result.includes('extract_a11y'));
    assert.ok(result.includes('navigate'));
    assert.ok(result.includes('run_script'));
  });
});

describe('SHORT_MODE_PROMPT', () => {
  it('exists and includes speak tag format', () => {
    assert.ok(SHORT_MODE_PROMPT.includes('<speak>'));
    assert.ok(SHORT_MODE_PROMPT.includes('MANDATORY'));
  });
});

describe('extractAndStripSpeak', () => {
  it('returns content unchanged and spokenText null when shortMode is false', () => {
    const result = extractAndStripSpeak('Hello world.', false);
    assert.equal(result.content, 'Hello world.');
    assert.equal(result.spokenText, null);
  });

  it('extracts spokenText and strips tags from content', () => {
    const text = '<speak>Already spoken.</speak>\nMore details.';
    const result = extractAndStripSpeak(text, true);
    assert.equal(result.spokenText, 'Already spoken.');
    assert.equal(result.content, 'More details.');
  });

  it('returns speak content as both content and spokenText when entire text is in speak tags', () => {
    const text = '<speak>Only this.</speak>';
    const result = extractAndStripSpeak(text, true);
    assert.equal(result.spokenText, 'Only this.');
    assert.equal(result.content, 'Only this.');
  });

  it('synthesizes spokenText from first sentence when no speak tag', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = extractAndStripSpeak(text, true);
    assert.equal(result.content, text);
    assert.ok(result.spokenText !== null);
    assert.ok(result.spokenText!.includes('First sentence.'));
    assert.ok(!result.spokenText!.includes('Second sentence.'));
  });

  it('falls back to first 100 chars when no sentence boundary', () => {
    const text = 'A very long response with no period or exclamation mark';
    const result = extractAndStripSpeak(text, true);
    assert.ok(result.spokenText !== null);
    assert.ok(result.spokenText!.length > 0);
  });

  it('strips code blocks before extracting sentences', () => {
    const text = '```\ncode block\n```\nFirst sentence. Second sentence.';
    const result = extractAndStripSpeak(text, true);
    assert.ok(result.spokenText !== null);
    assert.ok(result.spokenText!.includes('First sentence.'));
  });

  it('handles exclamation and question marks as boundaries', () => {
    const text = 'Great news! Everything works. More details here.';
    const result = extractAndStripSpeak(text, true);
    assert.ok(result.spokenText !== null);
    assert.ok(result.spokenText!.includes('Great news!'));
    assert.ok(!result.spokenText!.includes('Everything works.'));
  });

  it('returns null spokenText when summary is empty after stripping code', () => {
    const text = '```\nonly code\n```';
    const result = extractAndStripSpeak(text, true);
    assert.equal(result.content, text);
    assert.equal(result.spokenText, null);
  });

  it('strips partial unclosed <speak> tag at end of streaming text', () => {
    const text = 'Some response text<speak>partial content';
    const result = extractAndStripSpeak(text, true);
    assert.ok(!result.content.includes('<speak>'));
  });
});
