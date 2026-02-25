import { defineConfig, devices } from '@playwright/test';
import { createServer } from 'node:net';

/** Bind to port 0 to get an OS-assigned free port, then release it. */
function findFreePort(): number {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  const port = (srv.address() as { port: number }).port;
  srv.close();
  return port;
}

// Use explicit port if set (e.g. AIGENT_WEB_PORT=3142), otherwise pick a random free port.
// Store in process.env so global-setup and ws-client inherit it.
const PORT = Number(process.env['AIGENT_WEB_PORT']) || findFreePort();
process.env['AIGENT_WEB_PORT'] = String(PORT);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 0,
  workers: 1, // serial — single shared server instance
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    headless: true,
    screenshot: process.env['SCREENSHOTS'] ? 'on' : 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
