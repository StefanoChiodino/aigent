/**
 * System prompt builders — tests for host daemon prompt, browser extension
 * prompt, short mode prompt, and ensureSpeakTag heuristic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostSystemPrompt, buildBrowserExtSystemPrompt, ensureSpeakTag, SHORT_MODE_PROMPT } from './system-prompts.js';

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

describe('ensureSpeakTag', () => {
  it('returns text unchanged when shortMode is false', () => {
    assert.equal(ensureSpeakTag('Hello world.', false), 'Hello world.');
  });

  it('returns text unchanged when it already has <speak> tag', () => {
    const text = '<speak>Already spoken.</speak>\nMore details.';
    assert.equal(ensureSpeakTag(text, true), text);
  });

  it('synthesizes speak tag from first sentence only', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = ensureSpeakTag(text, true);
    assert.ok(result.startsWith('<speak>'));
    assert.ok(result.includes('First sentence.'));
    assert.ok(!result.slice(0, result.indexOf('</speak>')).includes('Second sentence.'));
    assert.ok(result.includes('</speak>'));
    assert.ok(result.includes(text));
  });

  it('falls back to first 100 chars when no sentence boundary', () => {
    const text = 'A very long response with no period or exclamation mark';
    const result = ensureSpeakTag(text, true);
    assert.ok(result.startsWith('<speak>'));
    assert.ok(result.includes('</speak>'));
  });

  it('strips code blocks before extracting sentences', () => {
    const text = '```\ncode block\n```\nFirst sentence. Second sentence.';
    const result = ensureSpeakTag(text, true);
    assert.ok(result.includes('First sentence.'));
  });

  it('handles exclamation and question marks as boundaries', () => {
    const text = 'Great news! Everything works. More details here.';
    const result = ensureSpeakTag(text, true);
    assert.ok(result.includes('<speak>'));
    assert.ok(result.includes('Great news!'));
    // Only the first sentence should be in the speak block
    assert.ok(!result.slice(0, result.indexOf('</speak>')).includes('Everything works.'));
  });

  it('returns original text when summary is empty after stripping', () => {
    const text = '```\nonly code\n```';
    const result = ensureSpeakTag(text, true);
    assert.equal(result, text);
  });
});
