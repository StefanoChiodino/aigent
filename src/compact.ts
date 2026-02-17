import type Anthropic from '@anthropic-ai/sdk';
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages/messages.js';

const COMPACT_PROMPT = `Summarize the conversation so far into a concise but thorough summary. Include:
- The user's goals and what they asked for
- Key decisions made
- What work was done (files created/modified, commands run, etc.)
- Current state and any pending tasks
- Important context that would be needed to continue the conversation

Be factual and specific. Include file paths, command names, and technical details.
Do NOT include pleasantries or meta-commentary about the summary itself.
Write as a compact reference document, not a narrative.`;

/**
 * Compact a conversation by summarizing old messages and keeping recent ones.
 *
 * Strategy:
 * 1. Keep the last `keepRecent` message pairs (user + assistant)
 * 2. Summarize everything before that into a single "context" message
 * 3. Return the compacted message array
 */
export async function compactConversation(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
  keepRecent: number = 6,
): Promise<{ messages: Anthropic.MessageParam[]; summary: string }> {
  // Don't compact if conversation is short
  if (messages.length <= keepRecent * 2) {
    return { messages, summary: '' };
  }

  // Split into old (to summarize) and recent (to keep)
  const splitPoint = messages.length - (keepRecent * 2);
  const oldMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  // Build a summary request
  const summaryMessages: Anthropic.MessageParam[] = [
    ...oldMessages,
    {
      role: 'user',
      content: COMPACT_PROMPT,
    },
  ];

  // Ensure the first message is from the user (API requirement)
  if (summaryMessages.length > 0 && summaryMessages[0]?.role !== 'user') {
    summaryMessages.unshift({
      role: 'user',
      content: '(conversation start)',
    });
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: summaryMessages,
  });

  const summary = response.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // Build compacted messages: summary as first exchange + recent messages
  const compacted: Anthropic.MessageParam[] = [
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
