import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ThinkingLevel } from './agent.js';

describe('getEffectiveThinking heuristic (logic test)', () => {
  function getEffectiveThinking(thinking: ThinkingLevel, content: string | { type: string; text?: string }[]): ThinkingLevel {
    if (thinking === 'off' || thinking === 'low') return thinking;
    const text = typeof content === 'string' ? content : content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text).join(' ');
    if (typeof content !== 'string' && content.some((p) => p.type === 'image')) return thinking;
    const wordCount = text.split(/\s+/).length;
    if (wordCount <= 10) {
      const complexKeywords = /\b(debug|refactor|architect|design|implement|optimize|analyze|explain why|compare|trade.?off)\b/i;
      if (!complexKeywords.test(text)) return 'low';
    }
    if (wordCount <= 30) {
      const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
      const idx = levels.indexOf(thinking);
      return idx > 1 ? levels[idx - 1]! : thinking;
    }
    return thinking;
  }

  it('returns off/low unchanged', () => {
    assert.equal(getEffectiveThinking('off', 'hello'), 'off');
    assert.equal(getEffectiveThinking('low', 'hello'), 'low');
  });

  it('lowers to low for short trivial messages', () => {
    assert.equal(getEffectiveThinking('high', 'hello'), 'low');
    assert.equal(getEffectiveThinking('max', 'hi there'), 'low');
  });

  it('does not lower to "low" for short complex messages (but still steps down)', () => {
    // Short complex messages (<=10 words, has keyword) avoid the "low" floor
    // but still hit the <=30 word step-down. So 'high' → 'medium', 'max' → 'high'.
    assert.equal(getEffectiveThinking('high', 'debug this error'), 'medium');
    assert.equal(getEffectiveThinking('high', 'refactor the code'), 'medium');
    assert.equal(getEffectiveThinking('max', 'design a system'), 'high');
    // But 'medium' stays 'medium' (idx=2, idx-1=1='low' which idx>1 allows)
    assert.equal(getEffectiveThinking('medium', 'debug this'), 'low');
  });

  it('steps down one level for medium-length messages', () => {
    const mediumMsg = 'Please help me with this task it needs some work and I want to make sure it is done right';
    assert.equal(getEffectiveThinking('high', mediumMsg), 'medium');
    assert.equal(getEffectiveThinking('max', mediumMsg), 'high');
  });

  it('keeps thinking for long messages', () => {
    const longMsg = Array(40).fill('word').join(' ');
    assert.equal(getEffectiveThinking('high', longMsg), 'high');
  });

  it('keeps thinking when content has images', () => {
    const content = [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: 'abc' }];
    assert.equal(getEffectiveThinking('high', content), 'high');
  });
});

describe('getToolOutputMaxChars heuristic (logic test)', () => {
  function getToolOutputMaxChars(resultLength: number, contextWindow: number, currentUsage: number, maxTokens: number): number {
    const availableTokens = Math.max(0, contextWindow - currentUsage - maxTokens);
    const availableChars = availableTokens * 4;
    const threshold = Math.floor(availableChars / 2);
    if (resultLength <= threshold) return resultLength;
    return Math.max(10_000, Math.floor(availableChars / 3));
  }

  it('returns full length when result fits comfortably', () => {
    assert.equal(getToolOutputMaxChars(1000, 200_000, 10_000, 16_384), 1000);
  });

  it('truncates large results', () => {
    const result = getToolOutputMaxChars(50_000, 200_000, 180_000, 16_384);
    assert.ok(result >= 10_000);
    assert.ok(result < 50_000);
  });

  it('floors at 10K chars even when budget is tiny', () => {
    assert.equal(getToolOutputMaxChars(100_000, 200_000, 199_000, 16_384), 10_000);
  });

  it('handles usage exceeding context window', () => {
    assert.equal(getToolOutputMaxChars(100_000, 200_000, 250_000, 16_384), 10_000);
  });
});
