/**
 * ToolLoopDetector — detects when the agent calls the same tool with identical
 * arguments repeatedly within a single turn (sliding-window check).
 *
 * Thresholds are configurable via env vars:
 *   AIGENT_LOOP_WINDOW      — number of recent tool calls to inspect (default: 10)
 *   AIGENT_LOOP_MAX_REPEATS — max times same (tool, args) may appear before halting (default: 5)
 *
 * One instance per agent turn — fresh instantiation resets the window.
 */

const DEFAULT_WINDOW = 10;
const DEFAULT_MAX_REPEATS = 5;

export class LoopDetectedError extends Error {
  constructor(tool: string, count: number, max: number) {
    super(
      `Loop detected: tool "${tool}" was called ${count} times with identical arguments ` +
      `(threshold: ${max}). The agent appears stuck. Please re-prompt with a different approach.`,
    );
    this.name = 'LoopDetectedError';
  }
}

interface ToolCall {
  name: string;
  input: unknown;
}

interface ToolLoopDetectorOptions {
  window?: number;
  maxRepeats?: number;
}

/** Stable JSON serialisation — sorts object keys so argument order doesn't matter. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort());
    }
    return val;
  });
}

export class ToolLoopDetector {
  private readonly window: number;
  private readonly maxRepeats: number;
  /** Ring buffer of (tool:args) keys for the last W calls. */
  private readonly history: string[] = [];

  constructor(opts?: ToolLoopDetectorOptions) {
    this.window = opts?.window
      ?? (process.env['AIGENT_LOOP_WINDOW'] ? Number(process.env['AIGENT_LOOP_WINDOW']) : DEFAULT_WINDOW);
    this.maxRepeats = opts?.maxRepeats
      ?? (process.env['AIGENT_LOOP_MAX_REPEATS'] ? Number(process.env['AIGENT_LOOP_MAX_REPEATS']) : DEFAULT_MAX_REPEATS);
  }

  /**
   * Record a batch of tool calls and check for repetition.
   * Throws `LoopDetectedError` if any (tool, args) key appears >= maxRepeats times
   * within the sliding window.
   *
   * Call once per agent iteration, passing all tool calls from that iteration.
   */
  check(calls: ToolCall[]): void {
    for (const call of calls) {
      const key = `${call.name}:${stableJson(call.input)}`;
      this.history.push(key);
      // Trim to window size
      if (this.history.length > this.window) {
        this.history.splice(0, this.history.length - this.window);
      }
      // Count occurrences of this key in the window
      const count = this.history.filter(k => k === key).length;
      if (count >= this.maxRepeats) {
        throw new LoopDetectedError(call.name, count, this.maxRepeats);
      }
    }
  }
}
