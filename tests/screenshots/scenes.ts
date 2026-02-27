/**
 * Declarative screenshot scene definitions.
 *
 * Each scene describes:
 *  - events to inject via /test/inject
 *  - optional UI actions (click buttons, type text, etc.)
 *  - viewport size, element to capture, delay
 *
 * The spec runner iterates SCENES and produces one PNG per scene
 * into docs/screenshots/<name>.png.
 *
 * Adding a screenshot = adding one object here.
 */

import type { Page } from '@playwright/test';

export interface ScreenshotScene {
  name: string;
  desc: string;
  viewport?: { width: number; height: number };
  events: Record<string, unknown>[];
  actions?: (page: Page) => Promise<void>;
  selector?: string;
  waitFor?: string;
  delay?: number;
}

const NOW = new Date().toISOString();

// ── Helpers ────────────────────────────────────────────────────────────────

function userMsg(content: string): Record<string, unknown>[] {
  return [
    { type: 'message', message: { role: 'user', content, timestamp: NOW } },
  ];
}

function assistantTurn(
  tools: { name: string; input: string; summary: string; output: string }[],
  text: string,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    { type: 'loading', isLoading: true },
  ];
  for (const t of tools) {
    events.push({ type: 'tool_start', name: t.name, input: t.input, summary: t.summary });
    events.push({ type: 'tool_output', content: t.output });
    events.push({ type: 'tool_end' });
  }
  events.push({ type: 'text', content: text });
  events.push({ type: 'message', message: { role: 'assistant', content: text, timestamp: NOW } });
  events.push({ type: 'loading', isLoading: false });
  return events;
}

function thinkingTurn(thinking: string, text: string): Record<string, unknown>[] {
  return [
    { type: 'loading', isLoading: true },
    { type: 'thinking', content: thinking },
    { type: 'text', content: text },
    { type: 'message', message: { role: 'assistant', content: text, timestamp: NOW } },
    { type: 'loading', isLoading: false },
  ];
}

// ── Scenes ─────────────────────────────────────────────────────────────────

export const SCENES: ScreenshotScene[] = [

  // 1. Hero: full chat with tool calls
  {
    name: 'chat',
    desc: 'Main chat interface with conversation and tool calls',
    events: [
      ...userMsg('Analyze this codebase — what are the main entry points and how is it structured?'),
      ...assistantTurn(
        [
          {
            name: 'exec',
            input: '{"command":"find src/ -name \'*.ts\' -maxdepth 1 | head -20"}',
            summary: 'find src/ -name \'*.ts\' | head -20',
            output: 'src/gatekeeper.tsx\nsrc/server.ts\nsrc/agent.ts\nsrc/provider.ts\nsrc/tools.ts\nsrc/safety.ts\nsrc/workspace.ts\nsrc/compact.ts\nsrc/worker.ts\nsrc/web-bridge.ts\nsrc/protocol.ts\nsrc/audit.ts\nsrc/logger.ts',
          },
          {
            name: 'grep',
            input: '{"pattern":"export default|export async function main","path":"src/"}',
            summary: 'grep exports in src/',
            output: 'src/gatekeeper.tsx:25: — main entry point\nsrc/server.ts:18: — agent server\nsrc/worker.ts:12: — sandbox supervisor',
          },
        ],
        'This is a **multi-process agent platform** with three main entry points:\n\n1. **`gatekeeper.tsx`** — the host process. Runs the web UI server, LLM proxy, and three-tier command safety system. This is the security boundary.\n2. **`server.ts`** — the agent server, spawned as a child process. Handles the conversation loop, tool execution, and workspace management.\n3. **`worker.ts`** — the sandbox supervisor that watches for source changes and manages hot-reload.\n\nThe architecture follows a **least-privilege model**: the gatekeeper holds API keys and gates every tool call. The agent process never has direct access to credentials.',
      ),
      // Add usage data so the context meter shows something
      { type: 'usage', usage: { input: 42000, output: 3500, cacheRead: 15000, cacheWrite: 4000, cost: 0.38, contextTokens: 65000 } },
    ],
    delay: 500,
  },

  // 2. Tool calls expanded
  {
    name: 'tool-calls',
    desc: 'Tool call blocks showing input and output',
    events: [
      ...userMsg('Show me the recent git history and search for TODO comments'),
      ...assistantTurn(
        [
          {
            name: 'exec',
            input: '{"command":"git log --oneline -8"}',
            summary: 'git log --oneline -8',
            output: 'baff8a5 fix: persist model and short mode across sessions\n6504418 feat: classifier suggested patterns, permission Enter guard\n49f39f2 fix: clear sessionStorage draft in test reset\nebdc991 permissions\n5b1d332 tidy from sandbox, bug fixes\na1e2f3b feat: add context inspector overlay\nc4d5e6f refactor: extract voice controls into sidebar\n7890abc docs: update architecture diagram',
          },
          {
            name: 'grep',
            input: '{"pattern":"TODO|FIXME|HACK","path":"src/"}',
            summary: 'grep TODO/FIXME in src/',
            output: 'src/agent.ts:142: // TODO: add retry logic for transient API errors\nsrc/tools.ts:89: // FIXME: timeout should be configurable per-tool\nsrc/compact.ts:67: // TODO: preserve tool call boundaries during compaction\nsrc/web-bridge.ts:203: // HACK: work around race condition in test mode reset',
          },
          {
            name: 'read_file',
            input: '{"path":"src/agent.ts","offset":140,"limit":5}',
            summary: 'read src/agent.ts:140-145',
            output: '140: async function retryWithBackoff(fn: () => Promise<void>) {\n141:   const maxRetries = 3;\n142:   // TODO: add retry logic for transient API errors\n143:   return fn();\n144: }',
          },
        ],
        'Found **4 TODO/FIXME comments** across the codebase. The most important ones:\n\n- `agent.ts:142` — retry logic placeholder (currently no-ops)\n- `compact.ts:67` — compaction may split tool call boundaries\n- `tools.ts:89` — hardcoded timeout, should be per-tool config',
      ),
    ],
    actions: async (page) => {
      // Expand all tool call blocks by toggling their expanded state via DOM
      await page.evaluate(() => {
        document.querySelectorAll('.tool-header').forEach(btn => {
          (btn as HTMLElement).click();
        });
      });
      // Scroll to show the tool blocks
      await page.evaluate(() => {
        const msgs = document.getElementById('messages');
        if (msgs) msgs.scrollTop = 0;
      });
    },
    delay: 500,
  },

  // 3. Permission modal (exec)
  {
    name: 'permission-exec',
    desc: 'Permission modal for shell command approval',
    events: [
      ...userMsg('Install the express package'),
      { type: 'loading', isLoading: true },
      { type: 'tool_start', name: 'exec', input: '{"command":"npm install express"}', summary: 'npm install express' },
      { type: 'exec_request', id: 'ss-exec-1', command: 'npm install express' },
    ],
    waitFor: '#perm-overlay:not(.hidden)',
    delay: 300,
  },

  // 4. Patch modal with diff
  {
    name: 'permission-patch',
    desc: 'Patch approval modal with diff viewer',
    events: [
      ...userMsg('Add error handling to the fetch tool'),
      {
        type: 'patch_request',
        id: 'ss-patch-1',
        diff: [
          '--- a/src/tools.ts',
          '+++ b/src/tools.ts',
          '@@ -245,8 +245,14 @@ async function executeFetch(url: string) {',
          '   const response = await fetch(url, {',
          '     signal: AbortSignal.timeout(30_000),',
          '   });',
          '-  const text = await response.text();',
          '-  return text;',
          '+  if (!response.ok) {',
          '+    const status = response.status;',
          '+    const statusText = response.statusText;',
          '+    throw new Error(`Fetch failed: ${status} ${statusText}`);',
          '+  }',
          '+  const text = await response.text();',
          '+  if (text.length > MAX_RESPONSE_SIZE) {',
          '+    return text.slice(0, MAX_RESPONSE_SIZE) + \'\\n[truncated]\';',
          '+  }',
          '+  return text;',
          ' }',
        ].join('\n'),
        reason: 'Add HTTP error handling and response size limiting to the fetch tool',
      },
    ],
    waitFor: '#perm-overlay:not(.hidden)',
    delay: 300,
  },

  // 5. Settings panel
  {
    name: 'settings',
    desc: 'Settings panel showing configuration groups',
    events: [],
    actions: async (page) => {
      await page.locator('#settings-btn').click();
      await page.waitForSelector('#settings-overlay:not(.hidden)');
    },
    delay: 400,
  },

  // 6. Context inspector
  {
    name: 'context-inspector',
    desc: 'Context window inspector with token breakdown',
    events: [
      // Inject some conversation first so usage meter is populated
      ...userMsg('How does the memory system work?'),
      ...assistantTurn([], 'The memory system uses a workspace directory...'),
      { type: 'usage', usage: { input: 85000, output: 12000, cacheRead: 30000, cacheWrite: 8000, cost: 1.24, contextTokens: 130000 } },
      {
        type: 'context_breakdown',
        breakdown: {
          systemBase: 4200,
          systemBaseContent: '# System\nYou are aigent, a self-modifying AI agent...',
          workspaceContext: 3800,
          workspaceContent: '## AGENTS.md\nGeneral workflow: Stick to this plan...',
          toolDefs: 2400,
          toolDefsContent: '[{"name":"exec"},{"name":"read_file"},{"name":"write_file"},...]',
          messages: [
            { role: 'user', tokens: 45, preview: 'How does the memory system work?' },
            { role: 'assistant', tokens: 580, preview: 'The memory system uses a workspace directory with config files...' },
            { role: 'user', tokens: 120, preview: 'Can you show me the workspace structure?' },
            { role: 'assistant', tokens: 340, preview: '```\n/workspace/\n├── config/\n│   ├── AGENTS.md...' },
            { role: 'tool_result', tokens: 210, preview: '{"result":"workspace/config/AGENTS.md\\nworkspace/config/SOUL.md..."}' },
            { role: 'assistant', tokens: 890, preview: 'Here is the full workspace structure with all config files...' },
          ],
          messagesTotal: 2185,
          total: 12585,
        },
      },
    ],
    actions: async (page) => {
      await page.evaluate(() => {
        const fn = (window as Record<string, unknown>).__testSetCtxInspectorOpen;
        if (typeof fn === 'function') (fn as (open: boolean) => void)(true);
      });
      await page.waitForSelector('#ctx-inspector-overlay:not(.hidden)');
      // Wait for server response then re-inject our data
      await page.waitForTimeout(500);
      // The test mode server may push its own breakdown, so we wait and let ours settle
    },
    delay: 500,
  },

  // 7. Background tasks
  {
    name: 'tasks',
    desc: 'Sidebar showing background tasks',
    events: [
      ...userMsg('Analyze the codebase for security issues and run the test suite'),
      ...assistantTurn(
        [
          {
            name: 'dispatch_task',
            input: '{"description":"Security audit of src/safety.ts and src/tools.ts","model":"claude-haiku-4-5-20251001"}',
            summary: 'dispatch: Security audit',
            output: 'Task dispatched: task-sec-1',
          },
          {
            name: 'dispatch_task',
            input: '{"description":"Run full test suite and report failures","model":"claude-haiku-4-5-20251001"}',
            summary: 'dispatch: Run tests',
            output: 'Task dispatched: task-test-1',
          },
        ],
        'I\'ve dispatched two background tasks:\n1. Security audit of the safety and tools modules\n2. Full test suite run\n\nBoth are running on Haiku to keep costs down. I\'ll report the results when they complete.',
      ),
      {
        type: 'task_update',
        task: {
          id: 'task-sec-1',
          description: 'Security audit of src/safety.ts and src/tools.ts',
          status: 'running',
          model: 'claude-haiku-4-5-20251001',
          startedAt: Date.now() - 45_000,
          contextTokens: 32000,
        },
      },
      {
        type: 'task_update',
        task: {
          id: 'task-test-1',
          description: 'Run full test suite and report failures',
          status: 'completed',
          model: 'claude-haiku-4-5-20251001',
          startedAt: Date.now() - 120_000,
          completedAt: Date.now() - 15_000,
          contextTokens: 18000,
          result: 'All 47 tests passed. No failures detected.',
        },
      },
      { type: 'usage', usage: { input: 52000, output: 4200, cacheRead: 0, cacheWrite: 0, cost: 0.45, contextTokens: 56000 } },
    ],
    delay: 400,
  },

  // 8. Thinking block
  {
    name: 'thinking',
    desc: 'Assistant message with visible thinking block',
    events: [
      ...userMsg('What\'s the best approach to add WebSocket reconnection logic?'),
      ...thinkingTurn(
        'The user wants WebSocket reconnection. Let me think about the current implementation...\n\n' +
        'Currently `web-bridge.ts` creates a single WebSocket connection in the browser. If it drops, ' +
        'the user sees a "disconnected" badge but has to manually reload.\n\n' +
        'Options:\n1. Exponential backoff reconnect in the WS client\n2. Use a library like `reconnecting-websocket`\n3. Add reconnection at the app level with state preservation\n\n' +
        'Option 1 is the simplest and most maintainable. The key considerations are:\n- Preserve message history (already in localStorage)\n- Re-request server state on reconnect\n- Show reconnection status in the UI\n- Cap retry attempts to avoid hammering a dead server',
        'Here\'s my recommended approach for WebSocket reconnection:\n\n**Exponential backoff** in the browser\'s WS client with these behaviors:\n\n1. On disconnect, start reconnecting with delays: 1s → 2s → 4s → 8s → 16s (capped)\n2. Show a "Reconnecting..." badge in the header\n3. On reconnect, re-request server state — messages are already preserved in `localStorage`\n4. After 10 failed attempts, show "Connection lost" with a manual retry button\n\nThis keeps it simple and doesn\'t require any new dependencies.',
      ),
    ],
    actions: async (page) => {
      // Expand the thinking block
      const thinkingToggle = page.locator('.thinking-toggle').first();
      if (await thinkingToggle.isVisible()) {
        await thinkingToggle.click();
      }
    },
    delay: 300,
  },

  // 9. Slash command palette
  {
    name: 'slash-commands',
    desc: 'Slash command palette with autocomplete',
    events: [],
    actions: async (page) => {
      await page.locator('#input').type('/');
    },
    waitFor: '#command-palette:not(.hidden)',
    delay: 300,
  },

  // 10. @ mention palette
  {
    name: 'at-palette',
    desc: '@ mention palette showing available actions',
    events: [],
    actions: async (page) => {
      await page.locator('#input').type('@');
    },
    waitFor: '#at-palette:not(.hidden)',
    delay: 300,
  },

  // 11. Narrow/PiP viewport
  {
    name: 'pip',
    desc: 'Narrow viewport showing compact layout',
    viewport: { width: 420, height: 720 },
    events: [
      ...userMsg('What time is it?'),
      ...assistantTurn([], 'I don\'t have access to a real-time clock, but I can run a command to check.'),
      { type: 'usage', usage: { input: 8000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 8500 } },
    ],
    delay: 300,
  },
];
