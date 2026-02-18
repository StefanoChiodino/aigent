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
 * Always returns an array with cache_control so the system prompt is cached.
 */
export function buildSystemPrompt(basePrompt: string, isOAuth: boolean): Anthropic.TextBlockParam[] {
  if (!isOAuth) {
    return [
      {
        type: 'text' as const,
        text: basePrompt,
        cache_control: { type: 'ephemeral' as const },
      },
    ];
  }

  return [
    {
      type: 'text' as const,
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: basePrompt,
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}
