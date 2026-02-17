import type { Provider, ProviderMessage } from './provider.js';

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
 * 2. Send the older messages to the provider with a summarization prompt
 * 3. Replace old messages with a summary exchange + recent messages
 *
 * Works with any provider — no Anthropic-specific types.
 */
export async function compactConversation(
  provider: Provider,
  model: string,
  messages: ProviderMessage[],
  keepRecent: number = 6,
): Promise<{ messages: ProviderMessage[]; summary: string }> {
  // Don't compact if conversation is short
  if (messages.length <= keepRecent * 2) {
    return { messages, summary: '' };
  }

  // Split into old (to summarize) and recent (to keep)
  const splitPoint = messages.length - (keepRecent * 2);
  const oldMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  // Build summary request: old messages + summarization prompt
  const summaryMessages: ProviderMessage[] = [];

  // Ensure first message is from user
  if (oldMessages.length > 0 && oldMessages[0]!.role !== 'user') {
    summaryMessages.push({ role: 'user', content: '(conversation start)' });
  }

  // Add old messages (skip tool_result messages — they don't make sense without context)
  for (const msg of oldMessages) {
    if (msg.role === 'user') {
      summaryMessages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      summaryMessages.push({ role: 'assistant', content: msg.content });
    }
    // Skip tool_result — the provider wouldn't know what tool_use they belong to
  }

  // Add the summarization request
  summaryMessages.push({ role: 'user', content: COMPACT_PROMPT });

  // Send to provider (no tools, no thinking — just a summary)
  const response = await provider.sendMessage(
    'You are a helpful assistant that summarizes conversations accurately.',
    summaryMessages,
    [], // no tools
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

  return { messages: compacted, summary };
}
