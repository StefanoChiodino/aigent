import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, ProviderMessage } from './provider.js';
import { createLogger } from './logger.js';

const log = createLogger('compact');

/**
 * Prompt variants for mid-conversation compaction.
 * Goal: stay task-focused, keep the agent on track. NOT long-term memory.
 */
const COMPACT_PROMPT_LIGHT = `Summarize completed topics from this conversation. Preserve all active threads, recent decisions, and ongoing work in detail. Only compress topics that are clearly finished.`;

const COMPACT_PROMPT = `Summarize this conversation as a compact reference for continuing the current task.

Include ALL of:
1. **Named entities & topics**: character names, chapter numbers, feature names, project names, people — use proper nouns, never "the character" or "the file"
2. **User goals**: what the user wants to achieve, both immediate and overarching
3. **Decisions made**: choices, preferences, direction changes
4. **Current state**: what's done, what's in progress, what's blocked
5. **Files & commands**: specific paths, commands run, errors encountered
6. **Active discussion threads**: ongoing conversations/debates not yet resolved

Start with a "Key entities:" line listing every named entity discussed.
Be specific and concrete — preserve the details that let someone pick up mid-conversation.
No narrative or meta-commentary.`;

const COMPACT_PROMPT_MODERATE = COMPACT_PROMPT;

const COMPACT_PROMPT_AGGRESSIVE = `Aggressively compress this conversation to essential context only. Keep: current task, key decisions, active file paths, critical errors. Drop: completed sub-tasks, exploration that led nowhere, verbose tool outputs, resolved discussions. Be extremely concise.`;

/**
 * Prompt for end-of-session/reset memory distillation.
 * Goal: extract what's worth keeping permanently across sessions.
 */
const DISTILL_PROMPT = `You are reviewing a conversation to extract what's worth keeping in long-term memory.

Review the conversation and the existing MEMORY.md content below. Output an updated MEMORY.md that:
- Preserves all existing content that is still accurate
- Adds new facts, decisions, lessons, or architectural knowledge from this conversation
- Updates or corrects any stale information
- Removes noise (failed experiments, temporary workarounds, trivial chit-chat)
- Keeps it concise — this file is loaded into every session's system prompt

Only include things that would be useful to know at the start of a future session:
- Key architectural decisions or changes made
- Important file paths, patterns, or conventions discovered
- Bugs found and fixed (with root cause)
- User preferences or communication style notes
- Unresolved TODOs or next steps worth remembering
- **Active threads**: what was being discussed/worked on at session end (character names, chapter numbers, feature names — use proper nouns). This is critical for continuity.

Output ONLY the updated MEMORY.md content. No preamble, no commentary.`;

/**
 * Convert messages to a summarizable format.
 * Includes tool results as abbreviated text so the summary captures what happened.
 */
function messagesToSummaryInput(messages: ProviderMessage[]): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  // Ensure first message is from user
  if (messages.length > 0 && messages[0]!.role !== 'user') {
    result.push({ role: 'user', content: '(conversation start)' });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      // Include tool call info — strip bulky fields (content, file data, base64)
      let text = msg.content;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolSummaries = msg.toolCalls.map((tc) => {
          const stripped = Object.fromEntries(
            Object.entries(tc.input).filter(([k]) => !['content', 'file_content', 'data', 'base64'].includes(k)),
          );
          const inputStr = JSON.stringify(stripped);
          const truncInput = inputStr.length > 150 ? inputStr.slice(0, 150) + '…' : inputStr;
          return `[${tc.name}: ${truncInput}]`;
        });
        text = text + '\n' + toolSummaries.join('\n');
      }
      result.push({ role: 'assistant', content: text });
    } else if (msg.role === 'tool_result') {
      // Abbreviated tool results — strip images, truncate text aggressively
      const parts = msg.results.map((r) => {
        let textContent: string;
        if (typeof r.content === 'string') {
          textContent = r.content;
        } else {
          const textParts = r.content
            .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text);
          const imageCount = r.content.filter((b) => b.type === 'image').length;
          textContent = textParts.join('\n');
          if (imageCount > 0) textContent += ` [+${imageCount} image(s)]`;
        }
        const truncated = textContent.length > 600
          ? textContent.slice(0, 600) + `… [${textContent.length}B]`
          : textContent;
        return `[result]: ${truncated}`;
      });
      result.push({ role: 'user', content: parts.join('\n') });
    }
  }

  return result;
}

/**
 * Find a good split point that doesn't break tool call/result pairs.
 * Walks backward from the target split to find a clean user message boundary.
 */
function findCleanSplitPoint(messages: ProviderMessage[], targetSplit: number): number {
  // Walk backward from target to find a message that starts a clean boundary.
  // Valid split points: before a 'user' message or before an 'assistant' message.
  // Splitting before assistant is safe because old messages end at a user/tool_result
  // boundary, and the recent section picks up from the assistant's response.
  // We must NOT split between an assistant (with toolCalls) and its tool_result.
  for (let i = targetSplit; i >= 1; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'user' || msg.role === 'assistant') {
      return i;
    }
  }
  // Fallback: use target as-is
  return targetSplit;
}

/**
 * Compact a conversation by summarizing old messages and keeping recent ones.
 * This is a MID-TASK operation — goal is to stay on track, not to persist memory.
 *
 * Strategy:
 * 1. Keep the last `keepRecent` user turns (a turn = user + assistant + tool exchanges)
 * 2. Summarize older messages so the agent retains context about what was done
 * 3. Replace old messages with summary + recent messages
 *
 * Does NOT write to MEMORY.md — that's for reset/session-end (distillToMemory).
 */
export async function compactConversation(
  provider: Provider,
  model: string,
  messages: ProviderMessage[],
  _workspacePath?: string,
  keepRecentTurns?: number,
  aggressiveness?: 'light' | 'moderate' | 'aggressive',
): Promise<{ messages: ProviderMessage[]; summary: string }> {
  // Resolve keepRecentTurns: explicit value takes priority, else derive from aggressiveness
  const defaultTurns = aggressiveness === 'light' ? 4 : aggressiveness === 'aggressive' ? 1 : 2;
  const effectiveTurns = keepRecentTurns ?? defaultTurns;
  // Resolve prompt
  const compactPrompt = aggressiveness === 'light'
    ? COMPACT_PROMPT_LIGHT
    : aggressiveness === 'aggressive'
      ? COMPACT_PROMPT_AGGRESSIVE
      : COMPACT_PROMPT_MODERATE;
  // Count "turns" — a turn is either a real user message OR a tool_result
  // (which the API sends as role:'user'). During long tool-use loops there may
  // be only 1 real user message but dozens of assistant+tool_result pairs.
  // We must count tool_results as turns so compaction can actually split
  // the history; otherwise splitIdx stays at messages.length and compaction
  // silently does nothing — the agent stalls.
  let turnCount = 0;
  let splitIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]!.role;
    if (role === 'user' || role === 'tool_result') {
      turnCount++;
      if (turnCount > effectiveTurns) {
        splitIdx = i + 1; // keep from i+1 onward
        break;
      }
    }
  }

  // Need a clean split that doesn't orphan tool results
  splitIdx = findCleanSplitPoint(messages, splitIdx);

  // Don't compact if there aren't enough old messages to summarize
  if (splitIdx < 2) {
    return { messages, summary: '' };
  }

  log.info('Compaction starting', { totalMessages: messages.length, splitIdx, effectiveTurns, aggressiveness });

  const oldMessages = messages.slice(0, splitIdx);
  const recentMessages = messages.slice(splitIdx);

  // Build summary input — includes abbreviated tool results
  const summaryMessages = messagesToSummaryInput(oldMessages);

  // Add the summarization request
  summaryMessages.push({ role: 'user', content: compactPrompt });

  // Send to provider (no tools, no thinking — just a summary)
  const response = await provider.sendMessage(
    'You are a helpful assistant that summarizes conversations accurately.',
    summaryMessages,
    [],
    { model, maxTokens: 4096, thinking: 'off' },
  );

  const summary = response.text;

  // Build compacted messages: summary as first exchange + recent messages
  const compacted: ProviderMessage[] = [
    {
      role: 'user',
      content: `[Context from earlier in this conversation — this is a summary, not a new message]\n\n${summary}`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the context from our earlier conversation. Continuing from where we left off.',
    },
    ...recentMessages,
  ];

  log.info('Compaction complete', { messagesBefore: messages.length, messagesAfter: compacted.length, summaryLength: summary.length });
  return { messages: compacted, summary };
}

/**
 * Distill a conversation into MEMORY.md.
 * Called on reset or session-end — NOT during mid-task compaction.
 *
 * Reads existing MEMORY.md, asks the model what's worth keeping from this
 * conversation, and writes back an updated MEMORY.md. Also appends a minimal
 * timestamp entry to the daily log for audit trail.
 *
 * Best-effort — errors are swallowed so they never block reset/shutdown.
 */
export async function distillToMemory(
  provider: Provider,
  model: string,
  messages: ProviderMessage[],
  workspacePath: string,
): Promise<void> {
  if (messages.length < 4) return;

  try {
    const memoryPath = join(workspacePath, 'MEMORY.md');
    const existingMemory = existsSync(memoryPath)
      ? readFileSync(memoryPath, 'utf-8')
      : '(empty — no memory yet)';

    const summaryMessages = messagesToSummaryInput(messages);

    // Include existing MEMORY.md so the model can merge intelligently
    summaryMessages.push({
      role: 'user',
      content: `${DISTILL_PROMPT}\n\n---\nExisting MEMORY.md:\n\n${existingMemory}`,
    });

    log.info('Distilling to MEMORY.md', { messages: messages.length });

    const response = await provider.sendMessage(
      'You are a careful memory curator. You update long-term memory files accurately and concisely.',
      summaryMessages,
      [],
      { model, maxTokens: 4096, thinking: 'off' },
    );

    const updatedMemory = response.text.trim();
    if (!updatedMemory) return;

    writeFileSync(memoryPath, updatedMemory + '\n');
    log.info('MEMORY.md updated', { bytes: updatedMemory.length });

    // Minimal audit entry in daily log
    const memoryDir = join(workspacePath, 'memory');
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 19);
    appendFileSync(
      join(memoryDir, `${today}.md`),
      `\n## Memory distilled (${time})\n\n(MEMORY.md updated — ${messages.length} messages processed)\n`,
    );
  } catch (err: unknown) {
    log.warn('distillToMemory failed (non-critical)', { error: (err as { message?: string }).message });
  }
}
