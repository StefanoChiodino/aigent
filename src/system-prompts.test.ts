/**
 * System prompt builders — tests for host daemon prompt, browser extension
 * prompt, and short mode prompt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostSystemPrompt, buildBrowserExtSystemPrompt, SHORT_MODE_PROMPT } from './system-prompts.js';

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
  it('exists and is MANDATORY', () => {
    assert.ok(SHORT_MODE_PROMPT.includes('MANDATORY'));
  });

  it('enforces 100 word hard limit', () => {
    assert.ok(SHORT_MODE_PROMPT.includes('100 words'));
  });

  it('does not reference speak_text tool (removed — TTS is now post-hoc)', () => {
    assert.ok(!SHORT_MODE_PROMPT.includes('speak_text'));
  });
});
