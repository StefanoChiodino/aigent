import type { DemoScenario } from './types';
import type { ServerEvent } from '../types';

// ── Text constants ──────────────────────────────────────────────────────────

const RESPONSE_1 =
  "I've added a health check endpoint to your server. Here's what I did:\n\n" +
  '1. **Read** `src/config.ts` to understand the existing route structure\n' +
  '2. **Searched** for route registration patterns across the codebase\n' +
  '3. **Added** a `/health` endpoint that returns `{ status: "ok", uptime: <seconds> }`\n\n' +
  'The endpoint is now available at `GET /health` and will return the server\'s ' +
  'uptime in seconds. You can use this for load balancer health checks or monitoring.';

const THINKING_1 =
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

const PATCH_1 =
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

const THINKING_2 =
  'The user wants me to write tests and also set up rate limiting on the health endpoint. ' +
  'Let me think about this:\n\n' +
  '1. First I\'ll check if there\'s a test framework already configured\n' +
  '2. Write a test for the /health endpoint\n' +
  '3. Add rate limiting middleware\n\n' +
  'I should also run the existing tests to make sure nothing is broken. Let me start by ' +
  'checking the test setup, then write the new test file, and finally add the rate limiter.';

const TEST_FILE =
  "import { describe, it, expect } from 'vitest';\n" +
  "import request from 'supertest';\n" +
  "import { app } from '../server';\n" +
  '\n' +
  "describe('/health', () => {\n" +
  "  it('returns 200 with status ok', async () => {\n" +
  "    const res = await request(app).get('/health');\n" +
  '    expect(res.status).toBe(200);\n' +
  "    expect(res.body.status).toBe('ok');\n" +
  "    expect(res.body.uptime).toBeGreaterThan(0);\n" +
  '  });\n' +
  '\n' +
  "  it('responds within 50ms', async () => {\n" +
  '    const start = Date.now();\n' +
  "    await request(app).get('/health');\n" +
  '    expect(Date.now() - start).toBeLessThan(50);\n' +
  '  });\n' +
  '});';

const PATCH_2 =
  '--- a/src/server.ts\n' +
  '+++ b/src/server.ts\n' +
  '@@ -1,5 +1,6 @@\n' +
  " import express from 'express';\n" +
  " import { config } from './config';\n" +
  "+import rateLimit from 'express-rate-limit';\n" +
  ' \n' +
  ' const app = express();\n' +
  '@@ -14,7 +15,12 @@\n' +
  ' \n' +
  ' // Health check endpoint\n' +
  '-app.get("/health", (_req, res) => {\n' +
  '+const healthLimiter = rateLimit({\n' +
  '+  windowMs: 60 * 1000,\n' +
  '+  max: 30,\n' +
  "+  message: { error: 'Too many requests' },\n" +
  '+});\n' +
  '+\n' +
  '+app.get("/health", healthLimiter, (_req, res) => {\n' +
  '   res.json({ status: "ok", uptime: process.uptime() });\n' +
  ' });';

const RESPONSE_2 =
  "Done! I've added tests and rate limiting for the health endpoint:\n\n" +
  '### Tests (`src/__tests__/health.test.ts`)\n' +
  '- Verifies the endpoint returns `200` with `{ status: "ok" }`\n' +
  '- Checks that uptime is a positive number\n' +
  '- Asserts response time is under 50ms\n\n' +
  '### Rate limiting\n' +
  '- Added `express-rate-limit` middleware to `/health`\n' +
  '- **30 requests per minute** per IP — prevents abuse while allowing monitoring\n' +
  '- Returns `{ error: "Too many requests" }` when limit exceeded\n\n' +
  'All existing tests pass. Run `npm test` to verify the new tests as well.';

const RESPONSE_3 =
  'Health endpoint looks good — status ok, uptime reporting correctly, rate limit headers active at 30/min. Ready for production.' +
  '\n\n<speak>Health endpoint checks out — status ok, rate limiting active.</speak>';

const RESPONSE_QUEUE_1 =
  "Sure — I'll add error handling next. I'll wrap the uptime call in a try/catch and " +
  'return `{ status: "error", reason: <message> }` with a 500 if anything throws.';

const RESPONSE_QUEUE_2 =
  "Agreed — I'll add a `cache-control: no-store` header to the /health response so " +
  'proxies and load balancers always get a fresh result.';

const RESPONSE_4 =
  "Done! I navigated to your app's checkout page and clicked the submit button. " +
  'The form submitted successfully — the page redirected to `/order/confirmed` with ' +
  'a 200 response. The confirmation page shows order #4821 with the correct total.';

const THINKING_BROWSER =
  "The user wants me to test the checkout flow in the browser. I need to:\n" +
  "1. Navigate to the checkout page using the browser extension\n" +
  "2. Click the submit button to test the form submission\n" +
  "3. Verify the redirect and confirmation page\n\n" +
  "I'll use browser_ext with run_script to execute the click action, then verify the result.";

// Fake browser confirmation page screenshot (SVG → base64 for tool_images)
const CONFIRMATION_SCREENSHOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200">' +
  '<rect width="360" height="200" fill="#1e1e2e" rx="8"/>' +
  '<rect width="360" height="28" fill="#313244" rx="8"/>' +
  '<rect y="22" width="360" height="6" fill="#313244"/>' +
  '<circle cx="16" cy="14" r="5" fill="#f38ba8"/>' +
  '<circle cx="32" cy="14" r="5" fill="#a6e3a1"/>' +
  '<circle cx="48" cy="14" r="5" fill="#f9e2af"/>' +
  '<text x="120" y="18" fill="#cdd6f4" font-family="sans-serif" font-size="10" text-anchor="middle">' +
  'localhost:3000/order/confirmed</text>' +
  '<text x="180" y="70" fill="#a6e3a1" font-family="sans-serif" font-size="18" font-weight="bold" text-anchor="middle">' +
  'Order Confirmed</text>' +
  '<text x="180" y="100" fill="#cdd6f4" font-family="sans-serif" font-size="12" text-anchor="middle">' +
  'Order #4821 &#8212; $127.50</text>' +
  '<rect x="60" y="120" width="240" height="1" fill="#45475a"/>' +
  '<text x="180" y="148" fill="#6c7086" font-family="sans-serif" font-size="10" text-anchor="middle">' +
  'Payment processed successfully</text>' +
  '<text x="180" y="168" fill="#6c7086" font-family="sans-serif" font-size="10" text-anchor="middle">' +
  'Confirmation email sent to user@example.com</text>' +
  '</svg>';

// Base64-encode the SVG for tool_images (which expects raw base64, not data URLs)
const CONFIRMATION_SCREENSHOT_B64 = typeof btoa !== 'undefined'
  ? btoa(CONFIRMATION_SCREENSHOT_SVG)
  : Buffer.from(CONFIRMATION_SCREENSHOT_SVG).toString('base64');

// Fake terminal screenshot (SVG data URL — shows a mini terminal with curl output)
const SCREENSHOT_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='130'%3E" +
  "%3Crect width='200' height='130' fill='%231e1e2e' rx='6'/%3E" +
  "%3Crect width='200' height='20' fill='%23313244' rx='6'/%3E" +
  "%3Crect y='14' width='200' height='6' fill='%23313244'/%3E" +
  "%3Ccircle cx='12' cy='10' r='4' fill='%23f38ba8'/%3E" +
  "%3Ccircle cx='24' cy='10' r='4' fill='%23a6e3a1'/%3E" +
  "%3Ccircle cx='36' cy='10' r='4' fill='%23f9e2af'/%3E" +
  "%3Ctext x='8' y='42' fill='%2389b4fa' font-family='monospace' font-size='9'%3E" +
  "$ curl localhost:3000/health%3C/text%3E" +
  "%3Ctext x='8' y='60' fill='%23a6adc8' font-family='monospace' font-size='9'%3E" +
  '%7B\"status\":\"ok\",\"uptime\":127%7D%3C/text%3E' +
  "%3Ctext x='8' y='78' fill='%236c7086' font-family='monospace' font-size='9'%3E" +
  "X-RateLimit-Limit: 30%3C/text%3E" +
  "%3Ctext x='8' y='94' fill='%236c7086' font-family='monospace' font-size='9'%3E" +
  "X-RateLimit-Remaining: 29%3C/text%3E" +
  "%3C/svg%3E";

// ── Helper to build emit steps more concisely ──────────────────────────────

function emit(event: ServerEvent): { action: 'emit'; event: ServerEvent } {
  return { action: 'emit' as const, event };
}

function wait(ms: number): { action: 'wait'; ms: number } {
  return { action: 'wait' as const, ms };
}

// ── Scenario ────────────────────────────────────────────────────────────────

export const DEMO_SCENARIO: DemoScenario = {
  name: 'aigent showcase',
  steps: [

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 1: Connection & initial state
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Connecting', id: 'connecting' },
    wait(800),
    emit({
      type: 'connected',
      state: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinking: 'high',
        short: false,
        profile: 'default',
        sessionId: 'demo-001',
        model: 'claude-sonnet-4-6',
        availableModels: [
          'claude-sonnet-4-6',
          'claude-opus-4-6',
          'claude-haiku-4-5-20251001',
        ],
        availableTools: ['read_file', 'write_file', 'edit_file', 'exec', 'grep', 'glob', 'fetch', 'tree', 'patch', 'search_memory', 'switch_model', 'dispatch_task', 'request_config_write', 'browser_ext', 'ask_user'],
        isLoading: false,
        tasks: [],
        pendingResults: 0,
      },
    }),
    emit({
      type: 'host_state',
      capabilities: {
        'clipboard.read': { grant: 'allow', available: true },
        'clipboard.write': { grant: 'allow', available: true },
        'screen.capture': { grant: 'prompt', available: false },
        'audio.play': { grant: 'prompt', available: false },
        'notify': { grant: 'prompt', available: false },
      },
      ttsAvailable: true,
      sttAvailable: true,
    }),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 2: First exchange — read config, add health endpoint
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'User types a message', id: 'first-message' },
    wait(1500),
    { action: 'type_input', text: 'Read the main config file and add a health check endpoint', charDelayMs: 45 },
    wait(800),
    { action: 'submit_input' },

    // User message echo
    emit({
      type: 'message',
      message: {
        role: 'user',
        content: 'Read the main config file and add a health check endpoint',
        timestamp: new Date().toISOString(),
      },
    }),

    // Agent starts
    emit({ type: 'loading', isLoading: true }),
    wait(300),

    // Extended thinking
    { action: 'label', text: 'Extended thinking', id: 'thinking' },
    { action: 'stream_thinking', text: THINKING_1, chunkSize: 6, intervalMs: 35 },
    wait(400),

    // Tool: search_memory — check past sessions
    { action: 'label', text: 'Tool: search memory', id: 'memory' },
    emit({
      type: 'tool_start',
      name: 'search_memory',
      summary: 'Searching for "health endpoint"',
      input: JSON.stringify({ query: 'health endpoint' }),
    }),
    wait(400),
    emit({ type: 'tool_output', content: 'No matching entries found.' }),
    emit({ type: 'tool_end' }),
    wait(200),

    // Tool: read_file
    { action: 'label', text: 'Tool: read file', id: 'tools' },
    emit({
      type: 'tool_start',
      name: 'read_file',
      summary: 'src/config.ts',
      input: JSON.stringify({ path: '/mnt/myapp/src/config.ts' }),
    }),
    wait(600),
    emit({ type: 'tool_output', content: CONFIG_FILE }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Tool: grep
    { action: 'label', text: 'Tool: grep search' },
    emit({
      type: 'tool_start',
      name: 'grep',
      summary: 'Finding route registration',
      input: JSON.stringify({ pattern: 'app\\.(get|post|use)', path: '/mnt/myapp/src' }),
    }),
    wait(400),
    emit({ type: 'tool_output', content: GREP_RESULT }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Permission: patch request (diff viewer)
    { action: 'label', text: 'Permission: file edit', id: 'permissions' },
    emit({
      type: 'patch_request',
      id: 'patch-001',
      diff: PATCH_1,
      reason: 'Adding health check endpoint to server.ts',
    }),
    { action: 'auto_approve', delayMs: 4500 },
    wait(500),

    // Streaming response
    { action: 'label', text: 'Streaming response', id: 'streaming' },
    { action: 'stream_text', text: RESPONSE_1, chunkSize: 4, intervalMs: 25 },

    // Finalize first exchange
    wait(200),
    emit({
      type: 'message',
      message: {
        role: 'assistant',
        content: RESPONSE_1,
        timestamp: new Date().toISOString(),
        elapsed: 4.2,
      },
    }),
    emit({ type: 'loading', isLoading: false }),

    // Usage update
    emit({
      type: 'usage',
      usage: {
        input: 12480,
        output: 1847,
        cacheRead: 8200,
        cacheWrite: 4280,
        cost: 0.042,
        contextTokens: 14327,
      },
    }),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 2.5: Ask user — agent asks for clarification
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Question: user input', id: 'ask-user' },
    wait(1500),
    emit({
      type: 'user_question_request',
      id: 'question-001',
      question: 'How should the health endpoint handle failures from downstream services?',
      options: [
        { label: 'Return 503', description: 'Return HTTP 503 with { status: "degraded" } when any dependency is unreachable' },
        { label: 'Always 200', description: 'Always return 200 but include per-dependency status in the response body' },
        { label: 'Separate endpoints', description: 'Add /health/live (always 200) and /health/ready (checks dependencies)' },
      ],
    }),
    { action: 'auto_approve', delayMs: 5000 },
    wait(500),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 3: Slash command palette, effort level, shortcuts modal
    // ════════════════════════════════════════════════════════════════════════

    // Slash command palette — type "/eff" to show matching commands
    { action: 'label', text: 'Command palette', id: 'command-palette' },
    wait(2000),
    { action: 'type_input', text: '/eff', charDelayMs: 120 },
    wait(2500),

    // Effort level pill — click "max" to upgrade reasoning budget
    { action: 'label', text: 'Effort level', id: 'effort' },
    { action: 'click', selector: '#sb-effort-pills .sb-pill[data-level="max"]' },
    wait(2000),

    // Keyboard shortcuts modal
    { action: 'label', text: 'Keyboard shortcuts', id: 'shortcuts' },
    { action: 'open_modal', modal: 'shortcuts' },
    wait(2500),
    { action: 'close_modal', modal: 'shortcuts' },
    wait(1000),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 4: Second exchange — tests, rate limiting, exec, fetch, task
    //  (Markdown-rich input showcases live syntax highlighting)
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Markdown input', id: 'second-message' },
    { action: 'type_input', text: 'Now **write tests** for it and add `express-rate-limit`. Check /src/server.ts and install the package if needed.', charDelayMs: 35 },
    wait(600),
    { action: 'submit_input' },

    emit({
      type: 'message',
      message: {
        role: 'user',
        content: 'Now **write tests** for it and add `express-rate-limit`. Check /src/server.ts and install the package if needed.',
        timestamp: new Date().toISOString(),
      },
    }),

    emit({ type: 'loading', isLoading: true }),
    wait(300),

    // Thinking
    { action: 'label', text: 'Agent reasoning' },
    { action: 'stream_thinking', text: THINKING_2, chunkSize: 8, intervalMs: 30 },
    wait(300),

    // Tool: glob — find test setup
    { action: 'label', text: 'Tool: glob search' },
    emit({
      type: 'tool_start',
      name: 'glob',
      summary: 'Finding test files',
      input: JSON.stringify({ pattern: 'src/**/*.test.*' }),
    }),
    wait(400),
    emit({ type: 'tool_output', content: 'src/__tests__/config.test.ts\nsrc/__tests__/routes.test.ts' }),
    emit({ type: 'tool_end' }),
    wait(200),

    // Tool: write_file — create test
    { action: 'label', text: 'Tool: write file' },
    emit({
      type: 'tool_start',
      name: 'write_file',
      summary: 'src/__tests__/health.test.ts',
      input: JSON.stringify({ path: '/mnt/myapp/src/__tests__/health.test.ts', content: TEST_FILE }),
    }),
    wait(500),
    emit({ type: 'tool_output', content: 'File written: src/__tests__/health.test.ts (324 bytes)' }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Permission: exec — npm install express-rate-limit (pipeline visualization)
    { action: 'label', text: 'Permission: shell command' },
    emit({
      type: 'exec_request',
      id: 'exec-001',
      command: 'npm install express-rate-limit',
      segments: [
        { raw: 'npm install express-rate-limit', operator: null, executable: 'npm', isSubshell: false },
      ],
    }),
    { action: 'auto_approve', delayMs: 4000 },
    wait(300),

    // Tool: exec output (simulated install)
    emit({
      type: 'tool_start',
      name: 'exec',
      summary: 'npm install express-rate-limit',
      input: JSON.stringify({ command: 'npm install express-rate-limit' }),
    }),

    // Classifier badge: Tier 3 LLM allowed this command
    emit({ type: 'classifier_decision', tier: 3, action: 'allow', reason: 'Package install — safe' }),
    wait(800),
    emit({
      type: 'tool_output',
      content:
        'added 1 package in 1.2s\n\n' +
        '1 package is looking for funding\n' +
        '  run `npm fund` for details',
    }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Tool: edit_file — add rate limiter to server.ts
    emit({
      type: 'tool_start',
      name: 'edit_file',
      summary: 'Adding rate limiter to server.ts',
      input: JSON.stringify({
        path: '/mnt/myapp/src/server.ts',
        old: 'app.get("/health", (_req, res) => {',
        new: 'const healthLimiter = rateLimit(...);\n\napp.get("/health", healthLimiter, (_req, res) => {',
      }),
    }),
    wait(400),
    emit({ type: 'tool_output', content: 'Edit applied: src/server.ts' }),
    emit({ type: 'tool_end' }),
    wait(200),

    // Permission: patch request (multi-line diff with import + rate limiter)
    { action: 'label', text: 'Permission: file edit' },
    emit({
      type: 'patch_request',
      id: 'patch-002',
      diff: PATCH_2,
      reason: 'Adding rate limiting to health check endpoint',
    }),
    { action: 'auto_approve', delayMs: 4500 },
    wait(400),

    // Permission: exec — run tests
    { action: 'label', text: 'Permission: run tests' },
    emit({
      type: 'exec_request',
      id: 'exec-002',
      command: 'npm test -- --reporter verbose 2>&1 | head -30',
      segments: [
        { raw: 'npm test -- --reporter verbose 2>&1', operator: null, executable: 'npm', isSubshell: false },
        { raw: 'head -30', operator: '|', executable: 'head', isSubshell: false },
      ],
    }),
    { action: 'auto_approve', delayMs: 3500 },
    wait(200),

    // Tool: exec — test output
    emit({
      type: 'tool_start',
      name: 'exec',
      summary: 'npm test',
      input: JSON.stringify({ command: 'npm test -- --reporter verbose 2>&1 | head -30' }),
    }),

    // Classifier badge: Tier 2 static allow for test runner
    emit({ type: 'classifier_decision', tier: 2, action: 'allow', reason: 'Test runner — static allow' }),
    wait(1000),
    emit({
      type: 'tool_output',
      content:
        ' ✓ src/__tests__/config.test.ts (3 tests) 12ms\n' +
        ' ✓ src/__tests__/routes.test.ts (8 tests) 45ms\n' +
        ' ✓ src/__tests__/health.test.ts (2 tests) 28ms\n\n' +
        ' Test Files  3 passed (3)\n' +
        '      Tests  13 passed (13)\n' +
        '   Duration  0.92s',
    }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Background task: spawn a sub-agent for documentation
    { action: 'label', text: 'Background sub-agent', id: 'sub-agents' },
    emit({
      type: 'task_update',
      task: {
        id: 'task-001',
        description: 'Updating API docs with /health endpoint',
        status: 'running',
        startedAt: new Date().toISOString(),
        model: 'claude-haiku-4-5-20251001',
      },
    }),
    wait(500),

    // Permission: fetch — check if the endpoint works
    { action: 'label', text: 'Permission: network fetch' },
    emit({
      type: 'fetch_request',
      id: 'fetch-001',
      url: 'http://localhost:3000/health',
      method: 'GET',
    }),
    { action: 'auto_approve', delayMs: 3500 },
    wait(200),

    // Tool: fetch result
    emit({
      type: 'tool_start',
      name: 'fetch',
      summary: 'GET http://localhost:3000/health',
      input: JSON.stringify({ url: 'http://localhost:3000/health', method: 'GET' }),
    }),
    wait(500),
    emit({
      type: 'tool_output',
      content: '200 OK\n\n{"status":"ok","uptime":127.384}',
    }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Background task completes
    emit({
      type: 'task_update',
      task: {
        id: 'task-001',
        description: 'Updating API docs with /health endpoint',
        status: 'completed',
        startedAt: new Date(Date.now() - 8000).toISOString(),
        completedAt: new Date().toISOString(),
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 3200,
        outputTokens: 890,
        cost: 0.004,
        delivery: 'agent-review',
      },
    }),
    wait(300),

    // Tool: switch_model — agent upgrades to Opus for code review
    { action: 'label', text: 'Tool: switch model', id: 'switch-model' },
    emit({
      type: 'tool_start',
      name: 'switch_model',
      summary: 'Upgrading to Opus for review',
      input: JSON.stringify({ model: 'claude-opus-4-6' }),
    }),
    wait(400),
    emit({ type: 'tool_output', content: 'Model switched to claude-opus-4-6' }),
    emit({ type: 'tool_end' }),
    // Reflect model change in UI
    emit({ type: 'state', model: 'claude-opus-4-6' }),
    wait(300),

    // Streaming response
    { action: 'stream_text', text: RESPONSE_2, chunkSize: 5, intervalMs: 22 },

    // Finalize second exchange
    wait(200),
    emit({
      type: 'message',
      message: {
        role: 'assistant',
        content: RESPONSE_2,
        timestamp: new Date().toISOString(),
        elapsed: 11.8,
      },
    }),
    emit({ type: 'loading', isLoading: false }),

    // Usage update (accumulated)
    emit({
      type: 'usage',
      usage: {
        input: 28940,
        output: 4210,
        cacheRead: 18600,
        cacheWrite: 10340,
        cost: 0.098,
        contextTokens: 33150,
      },
    }),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 5: Flash settings modal
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Settings panel', id: 'settings' },
    wait(2500),

    // Settings modal
    { action: 'open_modal', modal: 'settings' },
    wait(3000),
    { action: 'close_modal', modal: 'settings' },
    wait(1500),


    // Config write request — agent wants to update TOOLS.md
    { action: 'label', text: 'Permission: config write', id: 'config-write' },
    emit({
      type: 'config_write_request',
      id: 'cw-001',
      file: 'TOOLS.md',
      content: '# Tools\n\n## /health endpoint\n- GET /health — returns { status, uptime }\n- Rate limited: 30 req/min per IP\n- Added: express-rate-limit middleware',
      reason: 'Documenting new /health endpoint in TOOLS.md',
    }),
    { action: 'auto_approve', delayMs: 4500 },
    wait(500),

    // Context inspector — open, expand a couple of entries, then close
    { action: 'label', text: 'Context inspector', id: 'context-inspector' },
    { action: 'open_modal', modal: 'context' },
    wait(1500),

    // Expand "System prompt" bar (1st row in #ctx-inspector-bars)
    { action: 'click', selector: '#ctx-inspector-bars .ctx-bar-row-wrap:nth-child(1) .ctx-clickable' },
    wait(3000),

    // Collapse it, then expand "Workspace" bar (2nd row)
    { action: 'click', selector: '#ctx-inspector-bars .ctx-bar-row-wrap:nth-child(1) .ctx-clickable' },
    wait(500),
    { action: 'click', selector: '#ctx-inspector-bars .ctx-bar-row-wrap:nth-child(2) .ctx-clickable' },
    wait(2500),

    // Collapse workspace, expand a message row
    { action: 'click', selector: '#ctx-inspector-bars .ctx-bar-row-wrap:nth-child(2) .ctx-clickable' },
    wait(500),
    { action: 'click', selector: '#ctx-inspector-messages .ctx-msg-row-wrap:nth-child(2) .ctx-clickable' },
    wait(2500),

    // Collapse and close
    { action: 'click', selector: '#ctx-inspector-messages .ctx-msg-row-wrap:nth-child(2) .ctx-clickable' },
    wait(500),
    { action: 'close_modal', modal: 'context' },

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 5.4: Picture-in-Picture
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Picture-in-Picture', id: 'pip' },
    wait(1500),
    { action: 'click', selector: 'button[title="Float (PiP)"]' },
    wait(5000),
    { action: 'close_pip' },
    wait(1000),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 5.5: Background themes showcase
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Theme: Matrix', id: 'themes' },
    wait(1000),
    { action: 'set_theme', theme: 'matrix' },
    wait(4000),

    { action: 'label', text: 'Theme: Spectrum' },
    { action: 'set_theme', theme: 'spectrum' },
    wait(4000),

    { action: 'label', text: 'Theme: Milkdrop' },
    { action: 'set_theme', theme: 'milkdrop' },
    wait(4000),

    { action: 'label', text: 'Theme: Circular Spectrum' },
    { action: 'set_theme', theme: 'circular' },
    wait(4000),

    { action: 'label', text: 'Theme: Ember' },
    { action: 'set_theme', theme: 'ember' },
    wait(4000),

    // Back to default
    { action: 'label', text: 'Theme: Aurora' },
    { action: 'set_theme', theme: 'aurora' },
    wait(2000),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 5.75: Browser automation — run_script + navigate
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Browser automation', id: 'browser-automation' },
    wait(1500),

    // Extension connection indicator appears in sidebar
    emit({ type: 'host_state', extensionConnected: true }),
    wait(800),

    { action: 'type_input', text: 'Test the checkout flow — click submit and verify the confirmation page', charDelayMs: 40 },
    wait(600),
    { action: 'submit_input' },

    emit({
      type: 'message',
      message: {
        role: 'user',
        content: 'Test the checkout flow — click submit and verify the confirmation page',
        timestamp: new Date().toISOString(),
      },
    }),

    emit({ type: 'loading', isLoading: true }),
    wait(300),

    // Thinking about browser actions
    { action: 'stream_thinking', text: THINKING_BROWSER, chunkSize: 8, intervalMs: 30 },
    wait(300),

    // Browser write request: run_script (with "Go Autonomous" button visible)
    { action: 'label', text: 'Permission: browser action' },
    emit({
      type: 'browser_write_request',
      id: 'browser-001',
      action: 'run_script',
      stepSummary: 'Click the "Place Order" button on checkout page',
      tabUrl: 'http://localhost:3000/checkout',
      autonomousCmd: '/grant browser.autonomous',
    }),
    { action: 'auto_approve', delayMs: 4500 },
    wait(300),

    // Destructive browser action — ⚠ warning, "Always Allow" hidden
    { action: 'label', text: 'Browser: destructive action' },
    emit({
      type: 'browser_write_request',
      id: 'browser-001b',
      action: 'run_script',
      stepSummary: 'Click "Delete Test Order" in admin panel',
      tabUrl: 'http://localhost:3000/admin/orders',
      destructive: true,
      destructiveDetail: 'click "Delete Test Order" (delete)',
    }),
    { action: 'auto_approve', delayMs: 4000 },
    wait(300),

    // Browser action: navigate to verify
    { action: 'label', text: 'Browser: navigate' },
    emit({
      type: 'browser_write_request',
      id: 'browser-002',
      action: 'navigate',
      stepSummary: 'Navigate to /order/confirmed to verify redirect',
      tabUrl: 'http://localhost:3000/checkout',
    }),
    { action: 'auto_approve', delayMs: 3000 },
    wait(300),

    // Browser screenshot — verify confirmation page visually
    { action: 'label', text: 'Browser: screenshot' },
    emit({
      type: 'tool_start',
      name: 'browser_ext',
      summary: 'Screenshot /order/confirmed',
      input: JSON.stringify({ action: 'screenshot', tabId: 0 }),
    }),
    wait(400),
    emit({ type: 'tool_output', content: 'Screenshot captured (360×200, 2.4 KB)' }),
    emit({
      type: 'tool_images',
      images: [{ mediaType: 'image/svg+xml', data: CONFIRMATION_SCREENSHOT_B64 }],
    }),
    emit({ type: 'tool_end' }),
    wait(300),

    // Streaming browser result
    { action: 'stream_text', text: RESPONSE_4, chunkSize: 5, intervalMs: 22 },

    // Finalize browser exchange
    wait(200),
    emit({
      type: 'message',
      message: {
        role: 'assistant',
        content: RESPONSE_4,
        timestamp: new Date().toISOString(),
        elapsed: 3.6,
      },
    }),
    emit({ type: 'loading', isLoading: false }),

    // Usage update (accumulated)
    emit({
      type: 'usage',
      usage: {
        input: 32100,
        output: 4580,
        cacheRead: 20800,
        cacheWrite: 11300,
        cost: 0.105,
        contextTokens: 36680,
      },
    }),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 5.8: Message queueing — type while agent is busy
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Message queueing', id: 'message-queue' },
    wait(1500),

    // Start a new agent turn so isLoading goes true
    { action: 'type_input', text: 'Add error handling to the health endpoint', charDelayMs: 40 },
    wait(600),
    { action: 'submit_input' },

    emit({
      type: 'message',
      message: {
        role: 'user',
        content: 'Add error handling to the health endpoint',
        timestamp: new Date().toISOString(),
      },
    }),
    emit({ type: 'loading', isLoading: true }),
    wait(800),

    // While agent is busy, user types a second message — it queues
    { action: 'type_input', text: 'Also add a cache-control header', charDelayMs: 50 },
    wait(600),
    { action: 'submit_input' },
    // (message is now in the queue — shown as a chip above input)
    emit({ type: 'queue_update', queue: [{ id: 1, displayText: 'Also add a cache-control header' }] }),
    wait(2500),

    // Agent finishes first exchange — queued message auto-sends
    { action: 'stream_text', text: RESPONSE_QUEUE_1, chunkSize: 5, intervalMs: 22 },
    wait(200),
    emit({
      type: 'message',
      message: {
        role: 'assistant',
        content: RESPONSE_QUEUE_1,
        timestamp: new Date().toISOString(),
        elapsed: 2.8,
      },
    }),
    emit({ type: 'loading', isLoading: false }),

    // Queue drained — chip disappears
    emit({ type: 'queue_update', queue: [] }),

    // Agent picks up the queued message
    emit({
      type: 'message',
      message: {
        role: 'user',
        content: 'Also add a cache-control header',
        timestamp: new Date().toISOString(),
      },
    }),
    emit({ type: 'loading', isLoading: true }),
    wait(800),

    { action: 'stream_text', text: RESPONSE_QUEUE_2, chunkSize: 5, intervalMs: 22 },
    wait(200),
    emit({
      type: 'message',
      message: {
        role: 'assistant',
        content: RESPONSE_QUEUE_2,
        timestamp: new Date().toISOString(),
        elapsed: 1.9,
      },
    }),
    emit({ type: 'loading', isLoading: false }),

    emit({
      type: 'usage',
      usage: {
        input: 38400,
        output: 5200,
        cacheRead: 22400,
        cacheWrite: 12000,
        cost: 0.115,
        contextTokens: 43600,
      },
    }),

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 6: Concise/voice mode — STT, screenshot, TTS audio playback
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Speak: short', id: 'short-mode' },
    wait(2000),

    // Toggle short mode ON in the sidebar
    { action: 'set_short', on: true },
    wait(1000),

    // @mention palette — type "@" to show attachment/mention options
    { action: 'label', text: '@mention palette', id: 'at-palette' },
    { action: 'type_input', text: '@', charDelayMs: 0 },
    wait(2500),

    // File browser — type "@~/" to browse home directory
    { action: 'label', text: 'File browser', id: 'file-browser' },
    { action: 'type_input', text: '@~/', charDelayMs: 100 },
    wait(2500),
    // Navigate deeper into projects/
    { action: 'type_input', text: '@~/projects/', charDelayMs: 60 },
    wait(2000),
    // Navigate into myapp/
    { action: 'type_input', text: '@~/projects/myapp/', charDelayMs: 50 },
    wait(2000),
    // Filter by typing partial filename
    { action: 'type_input', text: '@~/projects/myapp/pkg', charDelayMs: 80 },
    wait(2000),

    // Simulate STT: TTS speaks with an alternate voice, mic animates, text "transcribed"
    { action: 'label', text: 'Voice input (STT)', id: 'voice-input' },
    { action: 'tts_to_stt', text: 'Does the endpoint look right?', src: './demo/user-input.mp3' },
    wait(400),

    // Attach a fake screenshot
    { action: 'label', text: 'Screenshot attachment' },
    {
      action: 'add_attachment',
      attachment: {
        id: 'demo-screenshot-001',
        name: 'terminal-output.png',
        mediaType: 'image/png',
        data: 'AAAA',  // placeholder — never actually sent anywhere
        dataUrl: SCREENSHOT_DATA_URL,
        size: 24_576,
      },
    },
    wait(1000),

    // Submit
    { action: 'submit_input' },
    { action: 'clear_attachments' },

    emit({
      type: 'message',
      message: {
        role: 'user',
        content: 'Does the endpoint look right?\n\n[Attached: terminal-output.png]',
        timestamp: new Date().toISOString(),
      },
    }),

    emit({ type: 'loading', isLoading: true }),
    wait(400),

    // Short-mode response (no extended thinking in short mode)
    { action: 'stream_text', text: RESPONSE_3, chunkSize: 8, intervalMs: 25 },

    // Finalize
    wait(200),
    emit({
      type: 'message',
      message: {
        role: 'assistant',
        content: RESPONSE_3,
        timestamp: new Date().toISOString(),
        elapsed: 1.4,
      },
    }),
    emit({ type: 'loading', isLoading: false }),

    // Agent speaks the response via edge-tts (default voice, no static file needed)
    { action: 'label', text: 'Voice output (TTS)', id: 'voice-output' },
    { action: 'speak_tts', text: 'Health endpoint checks out — status ok, rate limiting active.', src: './demo/agent-response.mp3' },

    // Usage update (accumulated)
    emit({
      type: 'usage',
      usage: {
        input: 44600,
        output: 6480,
        cacheRead: 29200,
        cacheWrite: 15400,
        cost: 0.148,
        contextTokens: 51080,
      },
    }),

    // Disable short mode for clean loop reset
    { action: 'set_short', on: false },

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 7: Loop
    // ════════════════════════════════════════════════════════════════════════

    { action: 'label', text: 'Restarting demo' },
    wait(5000),
    { action: 'loop' },
  ],
};
