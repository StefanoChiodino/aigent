import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';

/** Spawn a short-lived child to get an OS-assigned free port (listen is async). */
function findFreePort(): number {
  const port = execSync(
    `node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"`,
    { encoding: 'utf-8' },
  ).trim();
  return parseInt(port, 10);
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
