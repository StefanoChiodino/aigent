/**
 * Task queue for background agent work.
 *
 * Background agents run concurrently, but the main agent is single-threaded.
 * When tasks complete, their results queue up and are processed one at a time
 * — the main agent presents each result to the user in conversational order.
 *
 * Architecture:
 *   dispatch() → worker runs async → completes → result queued
 *   drainNext() → returns next completed result (FIFO) for main agent to process
 *   onTaskUpdate callback → notifies UI of state changes
 */

import type { BackgroundTaskInfo } from './protocol.js';
import { createLogger } from './logger.js';

const log = createLogger('tasks');

export interface TaskResult {
  id: string;
  description: string;
  status: 'completed' | 'failed';
  result: string;
  startedAt: string;
  completedAt: string;
  delivery: 'agent-review' | 'user-pull' | 'agent-batch';
}

export interface TaskQueueOptions {
  /** Called whenever a task's status changes (for UI updates). */
  onTaskUpdate?: (task: BackgroundTaskInfo) => void;
  /** Called when a result is ready and the main agent is idle. */
  onResultReady?: () => void;
}

interface TaskUsageMeta {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

interface InternalTask {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  result?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  delivery: 'agent-review' | 'user-pull' | 'agent-batch';
}

export class TaskQueue {
  private tasks = new Map<string, InternalTask>();
  private completionQueue: TaskResult[] = [];
  private counter = 0;
  private opts: TaskQueueOptions;

  constructor(opts: TaskQueueOptions = {}) {
    this.opts = opts;
  }

  /** Generate a short task ID. */
  private nextId(): string {
    return `task-${++this.counter}-${Date.now().toString(36)}`;
  }

  /** Register a new running task. Returns the task ID. */
  register(description: string, delivery: 'agent-review' | 'user-pull' | 'agent-batch' = 'agent-batch'): string {
    const id = this.nextId();
    const task: InternalTask = {
      id,
      description,
      status: 'running',
      startedAt: new Date().toISOString(),
      delivery,
    };
    this.tasks.set(id, task);
    log.info('Task registered', { id, description: task.description, delivery });
    this.opts.onTaskUpdate?.({ id, description: task.description, status: 'running', startedAt: task.startedAt, delivery });
    return id;
  }

  /** Update the model for a running task (so the UI can show it immediately). */
  setModel(id: string, model: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.model = model;
    this.opts.onTaskUpdate?.({
      id: task.id, description: task.description, status: task.status,
      startedAt: task.startedAt, delivery: task.delivery, model,
    });
  }

  /** Mark a task as completed and queue its result. */
  complete(id: string, result: string, meta?: TaskUsageMeta): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.result = result;
    if (meta?.model !== undefined) task.model = meta.model;
    if (meta?.inputTokens !== undefined) task.inputTokens = meta.inputTokens;
    if (meta?.outputTokens !== undefined) task.outputTokens = meta.outputTokens;
    if (meta?.cost !== undefined) task.cost = meta.cost;
    const durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    log.info('Task completed', { id, durationMs, model: task.model, cost: task.cost });

    this.completionQueue.push({
      id: task.id,
      description: task.description,
      status: 'completed',
      result,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      delivery: task.delivery,
    });

    this.opts.onTaskUpdate?.({
      id: task.id,
      description: task.description,
      status: 'completed',
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      delivery: task.delivery,
      // For user-pull tasks, send the raw result to the UI so it can display it
      ...(task.delivery === 'user-pull' ? { result } : {}),
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.inputTokens !== undefined ? { inputTokens: task.inputTokens } : {}),
      ...(task.outputTokens !== undefined ? { outputTokens: task.outputTokens } : {}),
      ...(task.cost !== undefined ? { cost: task.cost } : {}),
    });

    // Signal that a result is ready for the main agent
    this.opts.onResultReady?.();
  }

  /** Mark a task as failed and queue the error. */
  fail(id: string, error: string, meta?: TaskUsageMeta): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.result = error;
    if (meta?.model !== undefined) task.model = meta.model;
    const durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    log.error('Task failed', { id, error, durationMs });

    this.completionQueue.push({
      id: task.id,
      description: task.description,
      status: 'failed',
      result: error,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      delivery: task.delivery,
    });

    this.opts.onTaskUpdate?.({
      id: task.id,
      description: task.description,
      status: 'failed',
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      delivery: task.delivery,
      ...(task.delivery === 'user-pull' ? { result: error } : {}),
      ...(task.model !== undefined ? { model: task.model } : {}),
    });

    this.opts.onResultReady?.();
  }

  /** Cancel all running tasks (e.g. on user cancel). Discards their pending results. */
  cancelAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      task.status = 'cancelled';
      task.completedAt = new Date().toISOString();
      log.info('Task cancelled', { id: task.id });
      this.opts.onTaskUpdate?.({
        id: task.id,
        description: task.description,
        status: 'cancelled',
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      });
    }
    // Discard results that were queued by now-cancelled tasks
    this.completionQueue.length = 0;
  }

  /** Pop the next completed result for the main agent to process. Returns null if empty. */
  drainNext(): TaskResult | null {
    return this.completionQueue.shift() ?? null;
  }

  /** Check if there are results waiting. */
  hasPendingResults(): boolean {
    return this.completionQueue.length > 0;
  }

  /** Number of pending results. */
  get pendingCount(): number {
    return this.completionQueue.length;
  }

  /** Number of currently running tasks. */
  get runningCount(): number {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') count++;
    }
    return count;
  }

  /** Get info for all tasks (for UI / /tasks command). */
  getInfos(): BackgroundTaskInfo[] {
    return Array.from(this.tasks.values()).map(({ id, description, status, startedAt, completedAt, model, inputTokens, outputTokens, cost, delivery, result }) => ({
      id, description, status, startedAt, delivery,
      ...(completedAt ? { completedAt } : {}),
      ...(model ? { model } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
      // Include result for user-pull tasks so the UI can display it on reconnect
      ...(delivery === 'user-pull' && result ? { result } : {}),
    }));
  }

  /** Get info for running tasks only (for task list display). */
  getRunning(): BackgroundTaskInfo[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === 'running')
      .map(({ id, description, status, startedAt }) => ({ id, description, status, startedAt }));
  }

  /** Peek at the next result without removing it. */
  peekNext(): TaskResult | null {
    return this.completionQueue[0] ?? null;
  }

  /** Check if there are any agent-batch results pending. */
  hasBatchPending(): boolean {
    return this.completionQueue.some(r => r.delivery === 'agent-batch');
  }

  /** Drain only agent-batch results, leaving others in the queue. */
  drainBatch(): TaskResult[] {
    const batch: TaskResult[] = [];
    this.completionQueue = this.completionQueue.filter(r => {
      if (r.delivery === 'agent-batch') {
        batch.push(r);
        return false;
      }
      return true;
    });
    return batch;
  }

  /** Check if batched results are ready for delivery (no more running tasks). */
  readyForBatchDelivery(): boolean {
    if (!this.hasBatchPending()) return false;
    return this.runningCount === 0;
  }

  /** Clean up old completed/failed/cancelled tasks (keep last N). */
  prune(keepLast = 20): void {
    const all = Array.from(this.tasks.entries());
    const done = all.filter(([, t]) => t.status !== 'running');
    if (done.length > keepLast) {
      const toRemove = done.slice(0, done.length - keepLast);
      for (const [id] of toRemove) {
        this.tasks.delete(id);
      }
    }
  }
}
