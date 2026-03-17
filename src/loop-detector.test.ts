/**
 * Unit tests for ToolLoopDetector — repetitive tool call detection.
 *
 * Tests are written before the implementation (TDD). They import from
 * loop-detector.ts which does not exist yet, so they will fail initially.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopDetector, LoopDetectedError } from './loop-detector.js';

describe('ToolLoopDetector', () => {
  describe('triggers when threshold exceeded', () => {
    it('throws LoopDetectedError when same tool+args called >= N times within window', () => {
      const detector = new ToolLoopDetector({ window: 10, maxRepeats: 5 });
      const call = { name: 'grep', input: { pattern: 'foo', path: '/src' } };

      // 4 calls should be fine
      for (let i = 0; i < 4; i++) {
        assert.doesNotThrow(() => detector.check([call]));
      }
      // 5th identical call should throw
      assert.throws(() => detector.check([call]), LoopDetectedError);
    });

    it('error message names the looping tool', () => {
      const detector = new ToolLoopDetector({ window: 10, maxRepeats: 3 });
      const call = { name: 'read_file', input: { path: '/config.json' } };

      for (let i = 0; i < 2; i++) detector.check([call]);
      try {
        detector.check([call]);
        assert.fail('Expected LoopDetectedError');
      } catch (err) {
        assert.ok(err instanceof LoopDetectedError);
        assert.ok(err.message.includes('read_file'), `Expected tool name in message, got: ${err.message}`);
      }
    });

    it('triggers on multiple calls in a single iteration batch', () => {
      // If agent fans out 5 identical greps in one parallel batch, also detect it
      const detector = new ToolLoopDetector({ window: 10, maxRepeats: 5 });
      const call = { name: 'grep', input: { pattern: 'bar' } };
      assert.throws(() => detector.check([call, call, call, call, call]), LoopDetectedError);
    });
  });

  describe('does NOT trigger below threshold', () => {
    it('does not throw when repetitions are below threshold', () => {
      const detector = new ToolLoopDetector({ window: 10, maxRepeats: 5 });
      const call = { name: 'grep', input: { pattern: 'foo' } };

      for (let i = 0; i < 4; i++) {
        assert.doesNotThrow(() => detector.check([call]));
      }
    });

    it('does not throw when same tool is called with different args', () => {
      const detector = new ToolLoopDetector({ window: 10, maxRepeats: 3 });

      // Same tool, 10 different patterns — should never trigger
      for (let i = 0; i < 10; i++) {
        assert.doesNotThrow(() => detector.check([{ name: 'grep', input: { pattern: `pattern_${i}` } }]));
      }
    });

    it('counts distinct tool+arg pairs independently', () => {
      const detector = new ToolLoopDetector({ window: 10, maxRepeats: 3 });
      const callA = { name: 'grep', input: { pattern: 'foo' } };
      const callB = { name: 'grep', input: { pattern: 'bar' } };

      // Alternate between two patterns
      detector.check([callA]); // A=1, B=0
      detector.check([callB]); // A=1, B=1
      detector.check([callA]); // A=2, B=1
      // B has never hit 3, so it should not trigger
      assert.doesNotThrow(() => detector.check([callB])); // B=2, A=2 — neither at 3 yet
      // But calling A again (A=3) should trigger
      assert.throws(() => detector.check([callA]), LoopDetectedError); // A=3 → loop
    });
  });

  describe('sliding window eviction', () => {
    it('evicts old calls outside the window', () => {
      // window=5, maxRepeats=3: add 2 "grep foo", then 5 different calls to evict them,
      // then 2 more "grep foo" — should not trigger because old ones fell out
      const detector = new ToolLoopDetector({ window: 5, maxRepeats: 3 });
      const target = { name: 'grep', input: { pattern: 'target' } };

      detector.check([target]); // window: [target]
      detector.check([target]); // window: [target, target]

      // Push 5 different calls to evict the first two targets
      for (let i = 0; i < 5; i++) {
        detector.check([{ name: 'ls', input: { path: `/dir${i}` } }]);
      }

      // Now add target again — should only count 1 in window (or 0+1=1)
      assert.doesNotThrow(() => detector.check([target]));
    });
  });

  describe('turn isolation (per-instantiation reset)', () => {
    it('a new instance does not carry over counts from a previous instance', () => {
      const call = { name: 'read_file', input: { path: '/config.json' } };

      // First "turn": 4 calls (one below trigger)
      const detector1 = new ToolLoopDetector({ window: 10, maxRepeats: 5 });
      for (let i = 0; i < 4; i++) detector1.check([call]);

      // Second "turn": fresh detector — should not start at 4
      const detector2 = new ToolLoopDetector({ window: 10, maxRepeats: 5 });
      for (let i = 0; i < 4; i++) {
        assert.doesNotThrow(() => detector2.check([call]));
      }
    });
  });

  describe('env var configuration', () => {
    before(() => {
      process.env['AIGENT_LOOP_WINDOW'] = '6';
      process.env['AIGENT_LOOP_MAX_REPEATS'] = '2';
    });

    after(() => {
      delete process.env['AIGENT_LOOP_WINDOW'];
      delete process.env['AIGENT_LOOP_MAX_REPEATS'];
    });

    it('uses AIGENT_LOOP_WINDOW and AIGENT_LOOP_MAX_REPEATS when set', () => {
      // Default constructor reads env vars
      const detector = new ToolLoopDetector();
      const call = { name: 'exec', input: { command: 'ls' } };

      detector.check([call]); // count=1
      // 2nd call should trigger (maxRepeats=2 from env)
      assert.throws(() => detector.check([call]), LoopDetectedError);
    });

    it('uses defaults when env vars are absent', () => {
      // Temporarily clear env vars for this subtest
      delete process.env['AIGENT_LOOP_WINDOW'];
      delete process.env['AIGENT_LOOP_MAX_REPEATS'];

      const detector = new ToolLoopDetector();
      const call = { name: 'exec', input: { command: 'ls' } };

      // Default maxRepeats=5 — 4 calls should not trigger
      for (let i = 0; i < 4; i++) {
        assert.doesNotThrow(() => detector.check([call]));
      }

      // Restore for after() cleanup
      process.env['AIGENT_LOOP_WINDOW'] = '6';
      process.env['AIGENT_LOOP_MAX_REPEATS'] = '2';
    });
  });
});
