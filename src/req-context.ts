/**
 * Request context for correlating logs across the multi-process pipeline.
 *
 * Uses Node.js AsyncLocalStorage to automatically propagate a reqId
 * through async call chains without explicit parameter threading.
 *
 * Usage:
 *   import { reqContext, getReqId } from './req-context.js';
 *   await reqContext.run({ reqId: 'f9d8e7' }, async () => {
 *     // All code here (and any awaited calls) can read the reqId:
 *     getReqId(); // => 'f9d8e7'
 *   });
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ReqContext {
  reqId: string;
}

export const reqContext = new AsyncLocalStorage<ReqContext>();

/** Get the current reqId, or undefined if not in a request context. */
export function getReqId(): string | undefined {
  return reqContext.getStore()?.reqId;
}
