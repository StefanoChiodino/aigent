/**
 * Semantic index for episodes — stores embeddings alongside episode IDs
 * in a sidecar NDJSON file (workspace/episodes.index.ndjson).
 *
 * Uses @xenova/transformers for local neural embeddings (384-dim all-MiniLM-L6-v2).
 * Embeddings are computed fire-and-forget when episodes are appended.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { embed, cosineSimilarity } from './embeddings.js';
import type { Episode } from './episodes.js';
import { queryEpisodes } from './episodes.js';

const log = createLogger('episode-index');

const INDEX_FILE = 'episodes.index.ndjson';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IndexEntry {
  id: string;
  text: string;
  embedding: number[];
}

export interface SemanticSearchResult {
  episode: Episode;
  similarity: number;
}

// ---------------------------------------------------------------------------
// Text extraction — what gets embedded per episode
// ---------------------------------------------------------------------------

/** Build the searchable text from an episode's key fields. */
export function episodeToText(ep: Episode): string {
  const parts = [ep.task];
  if (ep.friction) parts.push(ep.friction);
  if (ep.lessons.length > 0) parts.push(ep.lessons.join('. '));
  if (ep.tags.length > 0) parts.push(ep.tags.join(' '));
  parts.push(ep.domain);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getIndexPath(workspacePath: string): string {
  return join(workspacePath, INDEX_FILE);
}

/** Check if an index file exists and has at least one entry. */
export function hasIndex(workspacePath: string): boolean {
  const path = getIndexPath(workspacePath);
  if (!existsSync(path)) return false;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read index
// ---------------------------------------------------------------------------

function readIndex(workspacePath: string): IndexEntry[] {
  const path = getIndexPath(workspacePath);
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return [];
    const entries: IndexEntry[] = [];
    for (const line of content.split('\n')) {
      try {
        entries.push(JSON.parse(line) as IndexEntry);
      } catch { /* skip malformed lines */ }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Index a single episode (fire-and-forget)
// ---------------------------------------------------------------------------

/** Compute embedding for an episode and append to the index file. */
export async function indexEpisode(workspacePath: string, ep: Episode): Promise<void> {
  try {
    const text = episodeToText(ep);
    const vector = await embed(text);
    const entry: IndexEntry = {
      id: ep.id,
      text,
      embedding: Array.from(vector),
    };
    appendFileSync(getIndexPath(workspacePath), JSON.stringify(entry) + '\n', 'utf-8');
    log.info(`Indexed episode ${ep.id.slice(0, 24)}...`);
  } catch (e) {
    log.warn(`Failed to index episode: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Rebuild full index from episodes.ndjson
// ---------------------------------------------------------------------------

/** Rebuild the entire index from the episodes file. Returns count of indexed episodes. */
export async function rebuildIndex(workspacePath: string): Promise<number> {
  const episodes = queryEpisodes(workspacePath, { limit: 200 });
  if (episodes.length === 0) return 0;

  const lines: string[] = [];
  for (const ep of episodes) {
    const text = episodeToText(ep);
    const vector = await embed(text);
    lines.push(JSON.stringify({ id: ep.id, text, embedding: Array.from(vector) }));
  }

  writeFileSync(getIndexPath(workspacePath), lines.join('\n') + '\n', 'utf-8');
  log.info(`Rebuilt index: ${lines.length} episodes`);
  return lines.length;
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

/** Search episodes by semantic similarity. Returns top-k results sorted by similarity. */
export async function searchEpisodesSemantic(
  workspacePath: string,
  query: string,
  opts?: { limit?: number; minSimilarity?: number },
): Promise<SemanticSearchResult[]> {
  const limit = opts?.limit ?? 5;
  const minSim = opts?.minSimilarity ?? 0.3;

  const entries = readIndex(workspacePath);
  if (entries.length === 0) return [];

  // Embed the query
  const queryVec = await embed(query);

  // Compute similarity against each indexed episode
  const scored: { id: string; similarity: number }[] = [];
  for (const entry of entries) {
    const entryVec = new Float32Array(entry.embedding);
    const sim = cosineSimilarity(queryVec, entryVec);
    if (sim >= minSim) {
      scored.push({ id: entry.id, similarity: sim });
    }
  }

  // Sort by similarity descending, take top-k
  scored.sort((a, b) => b.similarity - a.similarity);
  const topK = scored.slice(0, limit);

  if (topK.length === 0) return [];

  // Look up full episode records
  const allEpisodes = queryEpisodes(workspacePath, { limit: 200 });
  const episodeMap = new Map(allEpisodes.map(ep => [ep.id, ep]));

  const results: SemanticSearchResult[] = [];
  for (const item of topK) {
    const ep = episodeMap.get(item.id);
    if (ep) {
      results.push({ episode: ep, similarity: item.similarity });
    }
  }

  return results;
}
