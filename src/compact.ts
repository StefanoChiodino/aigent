import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, ProviderMessage } from './provider.js';
import { createLogger } from './logger.js';

const log = createLogger('compact');

/**
 * Prompt for mid-conversation compaction.
 * Goal: stay task-focused, keep the agent on track. NOT long-term memory.
 */
const COMPACT_PROMPT = `Summarize this conversation as a compact reference for continuing the current task. Include: user goals, decisions made, files changed, commands run, current state, pending tasks. Be specific (file paths, commands, technical details). No narrative or meta-commentary.`;

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
        const truncated = textContent.length > 300
          ? textContent.slice(0, 300) + `… [${textContent.length}B]`
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
  // Walk backward from target to find a 'user' message (not a tool_result)
  for (let i = targetSplit; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user') {
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
  keepRecentTurns: number = 4,
): Promise<{ messages: ProviderMessage[]; summary: string }> {
  // Count user turns (not counting tool_results as turns)
  let userTurnCount = 0;
  let splitIdx = messages.length;

  // Walk backward to find where to split, keeping `keepRecentTurns` user messages
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      userTurnCount++;
      if (userTurnCount > keepRecentTurns) {
        splitIdx = i + 1; // keep from i+1 onward
        break;
      }
    }
  }

  // Need a clean split that doesn't orphan tool results
  splitIdx = findCleanSplitPoint(messages, splitIdx);

  // Don't compact if conversation is too short
  if (splitIdx <= 2) {
    return { messages, summary: '' };
  }

  log.info('Compaction starting', { totalMessages: messages.length, splitIdx, keepRecentTurns });

  const oldMessages = messages.slice(0, splitIdx);
  const recentMessages = messages.slice(splitIdx);

  // Build summary input — includes abbreviated tool results
  const summaryMessages = messagesToSummaryInput(oldMessages);

  // Add the summarization request
  summaryMessages.push({ role: 'user', content: COMPACT_PROMPT });

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
