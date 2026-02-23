import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);
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
