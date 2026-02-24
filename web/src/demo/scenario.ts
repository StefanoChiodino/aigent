import type { DemoScenario } from './types';

const RESPONSE_TEXT =
  "I've added a health check endpoint to your server. Here's what I did:\n\n" +
  '1. **Read** `src/config.ts` to understand the existing route structure\n' +
  '2. **Searched** for route registration patterns across the codebase\n' +
  '3. **Added** a `/health` endpoint that returns `{ status: "ok", uptime: <seconds> }`\n\n' +
  'The endpoint is now available at `GET /health` and will return the server\'s ' +
  'uptime in seconds. You can use this for load balancer health checks or monitoring.';

const THINKING_TEXT =
  'The user wants me to read their config file first, then add a health check endpoint. ' +
  "Let me start by reading the existing configuration to understand the project structure. " +
  "I should look at how routes are registered so I can add the endpoint in the right place.\n\n" +
  'I\'ll need to:\n' +
  '1. Read the config file to understand the setup\n' +
  '2. Search for the route registration pattern\n' +
  '3. Add a /health endpoint with uptime info';

const CONFIG_FILE =
  'export const config = {\n' +
  '  port: 3000,\n' +
  '  host: "0.0.0.0",\n' +
  '  routes: {\n' +
  '    api: "/api/v1",\n' +
  '    docs: "/docs",\n' +
  '  },\n' +
  '  cors: { origin: "*" },\n' +
  '};';

const GREP_RESULT =
  'src/server.ts:12: app.use(config.routes.api, apiRouter);\n' +
  'src/server.ts:13: app.use(config.routes.docs, docsRouter);';

const PATCH_DIFF =
  '--- a/src/server.ts\n' +
  '+++ b/src/server.ts\n' +
  '@@ -11,6 +11,11 @@\n' +
  ' \n' +
  ' app.use(config.routes.api, apiRouter);\n' +
  ' app.use(config.routes.docs, docsRouter);\n' +
  '+\n' +
  '+// Health check endpoint\n' +
  '+app.get("/health", (_req, res) => {\n' +
  '+  res.json({ status: "ok", uptime: process.uptime() });\n' +
  '+});\n' +
  ' \n' +
  ' app.listen(config.port, config.host, () => {';

export const DEMO_SCENARIO: DemoScenario = {
  name: 'aigent showcase',
  steps: [
    // ── Phase 1: Connection ──
    { action: 'wait', ms: 800 },
    {
      action: 'emit',
      event: {
        type: 'connected',
        state: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          thinking: 'high',
          concise: false,
          profile: 'default',
          sessionId: 'demo-001',
          model: 'claude-sonnet-4-20250514',
          availableModels: [
            'claude-sonnet-4-20250514',
            'claude-opus-4-20250514',
            'claude-haiku-3-5-20241022',
          ],
          availableTools: ['read_file', 'write_file', 'edit_file', 'exec', 'grep', 'glob', 'fetch'],
          isLoading: false,
          tasks: [],
          pendingResults: 0,
        },
      },
    },
    {
      action: 'emit',
      event: {
        type: 'host_state',
        mounts: [
          { hostPath: '~/projects/myapp', containerPath: '/mnt/myapp', mode: 'rw' },
        ],
        capabilities: { clipboard: 'allow', audio: 'allow', screen: 'prompt' },
      },
    },

    // ── Phase 2: User types a message ──
    { action: 'wait', ms: 1500 },
    {
      action: 'type_input',
      text: 'Read the main config file and add a health check endpoint',
      charDelayMs: 45,
    },
    { action: 'wait', ms: 800 },
    { action: 'submit_input' },

    // User message echo
    {
      action: 'emit',
      event: {
        type: 'message',
        message: {
          role: 'user',
          content: 'Read the main config file and add a health check endpoint',
          timestamp: new Date().toISOString(),
        },
      },
    },

    // ── Phase 3: Agent starts working ──
    { action: 'emit', event: { type: 'loading', isLoading: true } },
    { action: 'wait', ms: 300 },

    // Extended thinking
    { action: 'stream_thinking', text: THINKING_TEXT, chunkSize: 6, intervalMs: 35 },
    { action: 'wait', ms: 400 },

    // ── Phase 4: Tool — read_file ──
    {
      action: 'emit',
      event: {
        type: 'tool_start',
        name: 'read_file',
        summary: 'src/config.ts',
        input: JSON.stringify({ path: '/mnt/myapp/src/config.ts' }),
      },
    },
    { action: 'wait', ms: 600 },
    { action: 'emit', event: { type: 'tool_output', content: CONFIG_FILE } },
    { action: 'emit', event: { type: 'tool_end' } },
    { action: 'wait', ms: 300 },

    // ── Phase 5: Tool — grep ──
    {
      action: 'emit',
      event: {
        type: 'tool_start',
        name: 'grep',
        summary: 'Finding route registration',
        input: JSON.stringify({ pattern: 'app\\.(get|post|use)', path: '/mnt/myapp/src' }),
      },
    },
    { action: 'wait', ms: 400 },
    { action: 'emit', event: { type: 'tool_output', content: GREP_RESULT } },
    { action: 'emit', event: { type: 'tool_end' } },
    { action: 'wait', ms: 300 },

    // ── Phase 6: Permission — patch request ──
    {
      action: 'emit',
      event: {
        type: 'patch_request',
        id: 'patch-001',
        diff: PATCH_DIFF,
        reason: 'Adding health check endpoint to server.ts',
      },
    },
    // Let user see the modal for 2.5s, then auto-approve
    { action: 'auto_approve', delayMs: 2500 },
    { action: 'wait', ms: 500 },

    // ── Phase 7: Streaming text response ──
    { action: 'stream_text', text: RESPONSE_TEXT, chunkSize: 4, intervalMs: 25 },

    // ── Phase 8: Finalize ──
    { action: 'wait', ms: 200 },
    {
      action: 'emit',
      event: {
        type: 'message',
        message: {
          role: 'assistant',
          content: RESPONSE_TEXT,
          timestamp: new Date().toISOString(),
          elapsed: 4.2,
        },
      },
    },
    { action: 'emit', event: { type: 'loading', isLoading: false } },

    // ── Phase 9: Usage update ──
    {
      action: 'emit',
      event: {
        type: 'usage',
        usage: {
          input: 12480,
          output: 1847,
          cacheRead: 8200,
          cacheWrite: 4280,
          cost: 0.042,
          contextTokens: 14327,
        },
      },
    },

    // ── Phase 10: Loop ──
    { action: 'wait', ms: 8000 },
    { action: 'loop' },
  ],
};
