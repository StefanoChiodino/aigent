/**
 * Generic pending-request broker.
 *
 * Eliminates the repeated Map + counter + Promise + timeout + abort + broadcast
 * pattern used by every permission/approval handler in server.ts.
 *
 * Each broker instance manages one category of request (exec, fetch, etc.).
 */

export interface PendingRequestOptions<TResponse> {
  /** Prefix for generated IDs, e.g. 'exec' → 'exec_1', 'exec_2' */
  prefix: string;
  /** Timeout in ms (default 60 000) */
  timeoutMs?: number;
  /** Response returned when the signal fires before the user responds */
  abortResponse: TResponse;
  /** Response returned when the timeout fires */
  timeoutResponse: TResponse;
}

export class PendingRequestBroker<TMeta, TResponse> {
  private map = new Map<string, { meta: TMeta; resolve: (r: TResponse) => void }>();
  private counter = 0;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly abortResponse: TResponse;
  private readonly timeoutResponse: TResponse;

  constructor(opts: PendingRequestOptions<TResponse>) {
    this.prefix = opts.prefix;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.abortResponse = opts.abortResponse;
    this.timeoutResponse = opts.timeoutResponse;
  }

  /**
   * Create a pending request. Returns [id, promise].
   * The caller is responsible for broadcasting the event to clients.
   */
  request(meta: TMeta, signal?: AbortSignal): [id: string, promise: Promise<TResponse>] {
    const id = `${this.prefix}_${++this.counter}`;

    if (signal?.aborted) {
      return [id, Promise.resolve(this.abortResponse)];
    }

    const promise = new Promise<TResponse>((resolve) => {
      const finish = (response: TResponse) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.map.delete(id);
        resolve(response);
      };

      const onAbort = () => finish(this.abortResponse);

      const timer = setTimeout(() => finish(this.timeoutResponse), this.timeoutMs);

      this.map.set(id, { meta, resolve: finish });

      signal?.addEventListener('abort', onAbort, { once: true });
    });

    return [id, promise];
  }

  /**
   * Resolve a pending request by ID. No-op if the ID is not found.
   */
  resolve(id: string, response: TResponse): void {
    const pending = this.map.get(id);
    if (pending) {
      this.map.delete(id);
      pending.resolve(response);
    }
  }

  /**
   * Iterate over all pending requests (for replay on client reconnect).
   */
  entries(): IterableIterator<[id: string, meta: TMeta]> {
    const inner = this.map.entries();
    return {
      [Symbol.iterator]() { return this; },
      next(): IteratorResult<[string, TMeta]> {
        const result = inner.next();
        if (result.done) return { done: true, value: undefined };
        return { done: false, value: [result.value[0], result.value[1].meta] };
      },
    };
  }

  /**
   * Replay all pending requests via a callback.
   * Used when a client reconnects and needs to see outstanding prompts.
   */
  replayTo(emit: (id: string, meta: TMeta) => void): void {
    for (const [id, { meta }] of this.map) {
      emit(id, meta);
    }
  }

  /** Number of pending requests. */
  get size(): number {
    return this.map.size;
  }
}
