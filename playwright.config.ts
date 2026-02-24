/**
 * Root-level Playwright config — re-exports from tests/playwright.config.ts
 * so that bare `npx playwright test` works from the project root.
 *
 * The canonical config lives in tests/playwright.config.ts. This file adjusts
 * relative paths (testDir, globalSetup, globalTeardown, outputDir) so they
 * resolve correctly when Playwright's cwd is the repo root instead of tests/.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/specs',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/playwright-report' }]],
  outputDir: 'tests/test-results',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
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
