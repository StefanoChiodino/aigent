/**
 * Screenshot generator — takes screenshots of the aigent UI for documentation.
 *
 * Uses the same test infrastructure as the e2e tests: AIGENT_TEST_MODE=1 with
 * /test/inject to push arbitrary UI state. Each "scene" is a declarative config
 * that defines what to inject and capture.
 *
 * Run:  make screenshots
 * Or:   AIGENT_TEST_MODE=1 npx playwright test --config tests/playwright.config.ts tests/screenshots.spec.ts
 *
 * Output: docs/screenshots/<name>.png
 */

import { test } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { waitForConnected } from '../helpers/ui.js';
import { SCENES } from '../screenshots/scenes.js';

const SCREENSHOTS_DIR = 'docs/screenshots';

for (const scene of SCENES) {
  test(`screenshot: ${scene.name} — ${scene.desc}`, async ({ page }) => {
    // Set viewport
    const vp = scene.viewport ?? { width: 1280, height: 900 };
    await page.setViewportSize(vp);

    // Navigate and wait for connection
    await page.goto('/');
    await waitForConnected(page);

    // Reset stores to clean state
    await page.evaluate(() => {
      const reset = (window as Record<string, unknown>).__testResetStores;
      if (typeof reset === 'function') (reset as () => void)();
    });
    await page.locator('#input').fill('');
    // Brief pause for reset to settle
    await page.waitForTimeout(200);

    // Inject events
    for (const event of scene.events) {
      await injectEvent(event);
    }

    // Run custom actions (before waitFor — actions may trigger the element)
    if (scene.actions) {
      await scene.actions(page);
    }

    // Wait for specific element if requested
    if (scene.waitFor) {
      await page.waitForSelector(scene.waitFor, { timeout: 5_000 });
    }

    // Wait for animations/rendering
    if (scene.delay) {
      await page.waitForTimeout(scene.delay);
    }

    // Kill all animations so screenshots are deterministic across runs.
    // The animated backgrounds (CSS bokeh blobs, canvas themes) produce different
    // pixels every frame, making PNGs differ even when the UI is identical.
    // Setting animation:none removes the animation entirely so elements snap back
    // to their static CSS positions — deterministic every time.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
        canvas { visibility: hidden !important; }
      `;
      document.head.appendChild(style);
    });
    // Let the static state paint
    await page.waitForTimeout(100);

    // Take screenshot
    const target = scene.selector ? page.locator(scene.selector) : page;
    await target.screenshot({ path: `${SCREENSHOTS_DIR}/${scene.name}.png` });
  });
}
