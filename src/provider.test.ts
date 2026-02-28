import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from './provider.js';

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
