/**
 * Reflection agent — mines patterns from recent episodes at session boundaries.
 *
 * Runs after distillToMemory at shutdown and /reset. Reads the last N episodes,
 * asks Haiku to identify recurring friction/success patterns, and appends
 * actionable insights to MEMORY.md and TODO.md.
 *
 * Cost: ~$0.005 per reflection (Haiku, ~5K input tokens).
 * Pattern: direct provider call with timeout, same as distillToMemory.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { queryEpisodes, type Episode } from './episodes.js';
import type { Provider } from './provider.js';

const log = createLogger('reflection');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReflectionResult {
  patternsFound: number;
  memoryUpdated: boolean;
  todoUpdated: boolean;
  insights: string[];
}

interface ReflectionOutput {
  patterns: Array<{
    description: string;
    frequency: number;
    episodeIds: string[];
    severity: 'low' | 'medium' | 'high';
  }>;
  memoryLessons: string[];
  todoItems: string[];
}

interface ReflectionRecord {
  timestamp: string;
  episodesAnalyzed: number;
  patternsFound: number;
  memoryLessons: string[];
  todoItems: string[];
  model: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MIN_EPISODES = 5;
const REFLECTIONS_FILE = 'reflections.ndjson';

const REFLECTION_SECTION = '## Reflection Insights (auto-generated)';
const TODO_SECTION = '## Reflection-Suggested';

const SYSTEM_PROMPT =
  'You are a careful analyst identifying patterns in structured episode data. Output only valid JSON.';

// ---------------------------------------------------------------------------
// Episode formatting
// ---------------------------------------------------------------------------

function formatEpisode(ep: Episode): string {
  const date = ep.endedAt.slice(0, 10);
  const rating = ep.userRating != null ? ` rating=${ep.userRating}/5` : '';
  const header = `[${date}] domain=${ep.domain} outcome=${ep.outcome}${rating}`;
  const lines = [header, `  Task: ${ep.task}`];
  if (ep.friction) lines.push(`  Friction: ${ep.friction}`);
  if (ep.lessons.length > 0) lines.push(`  Lessons: ${ep.lessons.join('; ')}`);
  if (ep.toolsUsed.length > 0) lines.push(`  Tools: ${ep.toolsUsed.join(', ')}`);
  return lines.join('\n');
}

function buildPrompt(episodes: Episode[], existingMemory: string, existingTodo: string): string {
  const formatted = episodes.map(formatEpisode).join('\n\n');
  return `You are reviewing a history of task episodes to identify patterns and extract actionable lessons.

Episodes (most recent first):
---
${formatted}
---

Existing MEMORY.md:
---
${existingMemory}
---

Existing TODO.md:
---
${existingTodo}
---

Analyze these episodes for:
1. RECURRING FRICTION — same failure mode appearing in 2+ episodes (e.g., forgetting build steps, permission timeouts, test failures from the same root cause)
2. RECURRING SUCCESS PATTERNS — techniques or approaches that consistently lead to good outcomes, worth codifying
3. LOW-RATED EPISODES — episodes rated 1-2 by the user; identify common factors
4. COST PATTERNS — unusually expensive tasks or domains where cheaper models could be used

Rules:
- Only report patterns supported by 2+ episodes. Never invent patterns from a single data point.
- Do NOT repeat lessons already present in MEMORY.md — check before suggesting.
- Do NOT suggest TODO items that are already in TODO.md.
- Be specific and actionable. "Be more careful" is not useful. "Always run make check before committing web/src changes" is useful.

Output strictly valid JSON (no markdown fences, no commentary):
{"patterns":[{"description":"...","frequency":2,"episodeIds":["..."],"severity":"low|medium|high"}],"memoryLessons":["line to add to MEMORY.md"],"todoItems":["- [ ] item to add to TODO.md"]}

If no patterns are found, output: {"patterns":[],"memoryLessons":[],"todoItems":[]}`;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

function readFileOrDefault(path: string, fallback: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch { /* fall through */ }
  return fallback;
}

function appendToSection(filePath: string, sectionHeader: string, newLines: string[]): void {
  const content = readFileOrDefault(filePath, '');
  const sectionIdx = content.indexOf(sectionHeader);

  if (sectionIdx !== -1) {
    // Section exists — append new lines after existing content in that section
    const afterSection = content.slice(sectionIdx + sectionHeader.length);
    const nextSectionIdx = afterSection.indexOf('\n## ');
    const insertPoint = nextSectionIdx !== -1
      ? sectionIdx + sectionHeader.length + nextSectionIdx
      : content.length;
    const newContent =
      content.slice(0, insertPoint).trimEnd() +
      '\n' + newLines.join('\n') + '\n' +
      (nextSectionIdx !== -1 ? '\n' + content.slice(insertPoint).trimStart() : '');
    writeFileSync(filePath, newContent);
  } else {
    // Section doesn't exist — create at end
    const separator = content.trim() ? '\n\n---\n\n' : '';
    writeFileSync(filePath, content.trimEnd() + separator + sectionHeader + '\n\n' + newLines.join('\n') + '\n');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const NO_OP: ReflectionResult = { patternsFound: 0, memoryUpdated: false, todoUpdated: false, insights: [] };

export async function runReflection(
  provider: Provider,
  workspacePath: string,
): Promise<ReflectionResult> {
  try {
    // Load recent episodes
    const episodes = queryEpisodes(workspacePath, { limit: 50 });
    if (episodes.length < MIN_EPISODES) {
      log.debug('Not enough episodes for reflection', { count: episodes.length, min: MIN_EPISODES });
      return NO_OP;
    }

    log.info('Running reflection', { episodes: episodes.length });

    // Read existing files for dedup context
    const memoryPath = join(workspacePath, 'MEMORY.md');
    const todoPath = join(workspacePath, '..', 'TODO.md');
    const existingMemory = readFileOrDefault(memoryPath, '(empty)');
    const existingTodo = readFileOrDefault(todoPath, '(empty)');

    // LLM call
    const prompt = buildPrompt(episodes, existingMemory, existingTodo);
    const response = await provider.sendMessage(
      SYSTEM_PROMPT,
      [{ role: 'user', content: prompt }],
      [],
      { model: HAIKU_MODEL, maxTokens: 2048, thinking: 'off' },
    );

    // Parse response
    let output: ReflectionOutput;
    try {
      output = JSON.parse(response.text) as ReflectionOutput;
    } catch {
      log.warn('Failed to parse reflection response as JSON', { text: response.text.slice(0, 200) });
      return NO_OP;
    }

    // Validate structure
    if (!Array.isArray(output.patterns) || !Array.isArray(output.memoryLessons) || !Array.isArray(output.todoItems)) {
      log.warn('Invalid reflection output structure');
      return NO_OP;
    }

    const result: ReflectionResult = {
      patternsFound: output.patterns.length,
      memoryUpdated: false,
      todoUpdated: false,
      insights: output.patterns.map(p => p.description),
    };

    // Update MEMORY.md
    if (output.memoryLessons.length > 0) {
      try {
        const lessons = output.memoryLessons.map(l => `- ${l}`);
        appendToSection(memoryPath, REFLECTION_SECTION, lessons);
        result.memoryUpdated = true;
        log.info('MEMORY.md updated with reflection insights', { count: lessons.length });
      } catch (err: unknown) {
        log.warn('Failed to update MEMORY.md', { error: (err as { message?: string }).message });
      }
    }

    // Update TODO.md
    if (output.todoItems.length > 0) {
      try {
        appendToSection(todoPath, TODO_SECTION, output.todoItems);
        result.todoUpdated = true;
        log.info('TODO.md updated with reflection suggestions', { count: output.todoItems.length });
      } catch (err: unknown) {
        log.warn('Failed to update TODO.md', { error: (err as { message?: string }).message });
      }
    }

    // Audit log
    try {
      if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
      const record: ReflectionRecord = {
        timestamp: new Date().toISOString(),
        episodesAnalyzed: episodes.length,
        patternsFound: output.patterns.length,
        memoryLessons: output.memoryLessons,
        todoItems: output.todoItems,
        model: HAIKU_MODEL,
      };
      appendFileSync(join(workspacePath, REFLECTIONS_FILE), JSON.stringify(record) + '\n', 'utf-8');
    } catch { /* non-critical */ }

    log.info('Reflection complete', { patternsFound: result.patternsFound, memoryUpdated: result.memoryUpdated, todoUpdated: result.todoUpdated });
    return result;
  } catch (err: unknown) {
    log.warn('Reflection failed (non-critical)', { error: (err as { message?: string }).message });
    return NO_OP;
  }
}
