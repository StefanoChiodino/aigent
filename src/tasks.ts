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
}

export interface TaskQueueOptions {
  /** Called whenever a task's status changes (for UI updates). */
  onTaskUpdate?: (task: BackgroundTaskInfo) => void;
  /** Called when a result is ready and the main agent is idle. */
  onResultReady?: () => void;
}

interface InternalTask {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: string;
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
  register(description: string): string {
    const id = this.nextId();
    const task: InternalTask = {
      id,
      description: description.length > 80 ? description.slice(0, 80) + '...' : description,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(id, task);
    log.info('Task registered', { id, description: task.description });
    this.opts.onTaskUpdate?.({ id, description: task.description, status: 'running', startedAt: task.startedAt });
    return id;
  }

  /** Mark a task as completed and queue its result. */
  complete(id: string, result: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.result = result;
    const durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    log.info('Task completed', { id, durationMs });

    this.completionQueue.push({
      id: task.id,
      description: task.description,
      status: 'completed',
      result,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    });

    this.opts.onTaskUpdate?.({
      id: task.id,
      description: task.description,
      status: 'completed',
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    });

    // Signal that a result is ready for the main agent
    this.opts.onResultReady?.();
  }

  /** Mark a task as failed and queue the error. */
  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.result = error;
    const durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    log.error('Task failed', { id, error, durationMs });

    this.completionQueue.push({
      id: task.id,
      description: task.description,
      status: 'failed',
      result: error,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    });

    this.opts.onTaskUpdate?.({
      id: task.id,
      description: task.description,
      status: 'failed',
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    });

    this.opts.onResultReady?.();
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
    return Array.from(this.tasks.values()).map(({ id, description, status, startedAt, completedAt }) => ({
      id, description, status, startedAt,
      ...(completedAt ? { completedAt } : {}),
    }));
  }

  /** Get info for running tasks only (for task list display). */
  getRunning(): BackgroundTaskInfo[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === 'running')
      .map(({ id, description, status, startedAt }) => ({ id, description, status, startedAt }));
  }

  /** Clean up old completed/failed tasks (keep last N). */
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
