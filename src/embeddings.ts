/**
 * Local neural embeddings via @xenova/transformers.
 *
 * Lazy-loads the embedding model on first use (~22MB download to ~/.cache/).
 * After loading, each embed() call takes ~50-100ms on CPU.
 */

import { createLogger } from './logger.js';

const log = createLogger('embeddings');

// ---------------------------------------------------------------------------
// Lazy model loading
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipeline: any = null;
let loading: Promise<unknown> | null = null;

async function getEmbedder(): Promise<unknown> {
  if (pipeline) return pipeline;
  if (loading) return loading;
  loading = (async () => {
    log.info('Loading embedding model (first-time download may take a few seconds)...');
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    log.info('Embedding model loaded');
    return pipeline;
  })();
  return loading;
}

/** Whether the embedding model has been loaded and is ready for synchronous-ish use. */
export function isEmbeddingReady(): boolean {
  return pipeline !== null;
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

/** Compute a 384-dimensional embedding for a single text string. */
export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = await (embedder as any)(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/** Compute embeddings for multiple texts (sequential — no batch API in transformers.js). */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure math — no dependencies)
// ---------------------------------------------------------------------------

/** Cosine similarity between two vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('Vectors must have the same length');
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Reset the pipeline for test isolation. */
export function _resetForTest(): void {
  pipeline = null;
  loading = null;
}
