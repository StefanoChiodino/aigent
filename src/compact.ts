import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, ProviderMessage } from './provider.js';

const COMPACT_PROMPT = `Summarize the conversation so far into a concise but thorough summary. Include:
- The user's goals and what they asked for
- Key decisions made
- What work was done (files created/modified, commands run, tool results)
- Current state and any pending tasks
- Important context that would be needed to continue the conversation

Be factual and specific. Include file paths, command names, and technical details.
Do NOT include pleasantries or meta-commentary about the summary itself.
Write as a compact reference document, not a narrative.`;

/**
 * Persist a compaction summary to the daily memory file.
 * This ensures context survives conversation resets.
 */
function persistSummary(workspacePath: string, summary: string): void {
  try {
    const memoryDir = join(workspacePath, 'memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const memoryFile = join(memoryDir, `${today}.md`);
    const timestamp = new Date().toISOString().slice(11, 19);

    const entry = `\n\n## Compaction Summary (${timestamp})\n\n${summary}\n`;

    if (!existsSync(memoryFile)) {
      appendFileSync(memoryFile, `# ${today}\n${entry}`);
    } else {
      appendFileSync(memoryFile, entry);
    }
  } catch {
    // Non-critical — don't break compaction over a file write failure
  }
}

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
      // Include tool call info in the assistant text so the summary knows what happened
      let text = msg.content;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolSummaries = msg.toolCalls.map((tc) => {
          const inputStr = JSON.stringify(tc.input);
          const truncInput = inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr;
          return `[Tool: ${tc.name}(${truncInput})]`;
        });
        text = text + '\n' + toolSummaries.join('\n');
      }
      result.push({ role: 'assistant', content: text });
    } else if (msg.role === 'tool_result') {
      // Include abbreviated tool results as a user message
      // (API requires alternating user/assistant, and tool results are context)
      const parts = msg.results.map((r) => {
        const content = r.content;
        const truncated = content.length > 500
          ? content.slice(0, 500) + `… [${content.length} bytes total]`
          : content;
        return `[Tool result]: ${truncated}`;
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
 *
 * Strategy:
 * 1. Keep the last `keepRecent` user turns (a turn = user + assistant + tool exchanges)
 * 2. Send the older messages (including tool results) to the provider for summarization
 * 3. Replace old messages with a summary exchange + recent messages
 * 4. Persist the summary to the daily memory file
 *
 * Works with any provider — no Anthropic-specific types.
 */
export async function compactConversation(
  provider: Provider,
  model: string,
  messages: ProviderMessage[],
  workspacePath?: string,
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

  // Persist summary to daily memory file
  if (workspacePath) {
    persistSummary(workspacePath, summary);
  }

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

  return { messages: compacted, summary };
}
