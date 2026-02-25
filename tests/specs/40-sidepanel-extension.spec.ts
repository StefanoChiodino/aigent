/**
 * 40 — Extension side panel: loads the real Chrome extension in Playwright
 * and verifies the side panel iframe renders correctly.
 *
 * Uses Playwright's Chrome extension loading to load the actual
 * aigent-extension/dist/ and open the side panel.
 *
 * NOTE: Chrome extensions require a non-headless browser.
 * Run with: EXTENSION_TEST=1 npx playwright test 40-sidepanel-extension
 */

import { test, expect, chromium } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = resolve(__dirname, '../../aigent-extension/dist');
const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);

// Skip unless EXTENSION_TEST=1 is set (these require a real Chrome with extension support)
test.skip(!process.env['EXTENSION_TEST'], 'Set EXTENSION_TEST=1 to run extension tests');

test.describe('Extension side panel rendering', () => {
  test('side panel iframe renders the app (not blank)', async () => {
    // Launch Chrome with the extension loaded
    const browserContext = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });

    try {
      // Get the background service worker page (if any)
      const pages = browserContext.pages();
      const page = pages[0] ?? await browserContext.newPage();

      // Navigate to extension's sidepanel directly
      // The sidepanel HTML loads the iframe pointing to localhost
      // We can access it via chrome-extension:// URL if we know the ID,
      // OR we can open the sidepanel URL directly in a tab for testing.

      // First approach: open the sidepanel.html directly as a page
      // This simulates what Chrome does when the side panel opens.
      // The extension ID is discoverable from service workers.
      let extensionId: string | null = null;

      // Wait for service workers to register
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const workers = browserContext.serviceWorkers();
      for (const worker of workers) {
        const url = worker.url();
        if (url.includes('aigent') || url.includes('background/worker')) {
          const match = url.match(/chrome-extension:\/\/([a-z]+)\//);
          if (match) {
            extensionId = match[1]!;
            break;
          }
        }
      }

      if (!extensionId) {
        // Try extracting from any extension URL
        for (const worker of workers) {
          const match = worker.url().match(/chrome-extension:\/\/([a-z]+)\//);
          if (match) {
            extensionId = match[1]!;
            break;
          }
        }
      }

      expect(extensionId, 'Could not find extension ID').not.toBeNull();

      // Open the sidepanel HTML directly
      const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel/sidepanel.html`;
      await page.goto(sidepanelUrl);

      // Wait for the iframe to be present
      const frame = page.locator('#frame');
      await expect(frame).toBeAttached({ timeout: 5_000 });

      // Check iframe src is set correctly
      const iframeSrc = await frame.getAttribute('src');
      expect(iframeSrc).toContain('localhost');
      expect(iframeSrc).toContain('extId=');

      // Wait for iframe to load — get the frame content
      const iframeElement = await page.waitForSelector('#frame', { timeout: 5_000 });
      const iframeContentFrame = await iframeElement.contentFrame();

      if (iframeContentFrame) {
        // Check React mounted
        const rootHasContent = await iframeContentFrame.evaluate(() => {
          const root = document.getElementById('root');
          return root !== null && root.children.length > 0;
        });
        expect(rootHasContent).toBe(true);

        // Check for JS errors
        const jsErrors: string[] = [];
        page.on('pageerror', (err) => jsErrors.push(err.message));

        expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
      } else {
        // iframe cross-origin — verify via the offline indicator instead
        const offline = page.locator('#offline');
        const offlineDisplay = await offline.evaluate((el) => window.getComputedStyle(el).display);
        expect(offlineDisplay, 'offline indicator should be hidden if server is running').toBe('none');
      }
    } finally {
      await browserContext.close();
    }
  });
});
