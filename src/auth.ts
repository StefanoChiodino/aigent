import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_CODE_VERSION = '2.1.2';

const OAUTH_BETA_FEATURES = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
];

export function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes('sk-ant-oat');
}

/**
 * Creates an Anthropic client configured for the given API key type.
 *
 * OAT (setup-token / subscription) keys require:
 * - Bearer auth instead of x-api-key
 * - Claude Code identity headers and beta flags
 * - A specific system prompt prefix
 *
 * This mirrors how pi-ai / OpenClaw handles subscription auth.
 * See: docs/secret-management.md for research notes.
 */
export function createClient(apiKey: string): { client: Anthropic; isOAuth: boolean } {
  if (isOAuthToken(apiKey)) {
    const client = new Anthropic({
      apiKey: null as unknown as string,
      authToken: apiKey,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        accept: 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': OAUTH_BETA_FEATURES.join(','),
        'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
        'x-app': 'cli',
      },
    });
    return { client, isOAuth: true };
  }

  const client = new Anthropic({ apiKey });
  return { client, isOAuth: false };
}

/**
 * Build system prompt with cache control for prompt caching.
 * OAT tokens additionally require the Claude Code identity prefix.
 *
 * Accepts a string (legacy) or string[] (split caching):
 * - string[0] = stable base instructions → cache_control: ephemeral (cache hit across turns)
 * - string[1+] = dynamic sections (workspace context) → no cache_control (re-tokenized each turn)
 * This saves ~$0.50-1.00/session by keeping the big static block cached.
 */
export function buildSystemPrompt(prompt: string | string[], isOAuth: boolean): Anthropic.TextBlockParam[] {
  const parts = Array.isArray(prompt) ? prompt : [prompt];
  const blocks: Anthropic.TextBlockParam[] = [];

  if (isOAuth) {
    blocks.push({
      type: 'text' as const,
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
      cache_control: { type: 'ephemeral' as const },
    });
  }

  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    blocks.push({
      type: 'text' as const,
      text: parts[i]!,
      // Cache the stable base (first block); leave dynamic sections uncached
      ...(i === 0 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    });
  }

  return blocks;
}
