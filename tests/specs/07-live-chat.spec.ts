/**
 * 07 — Live LLM tests @live
 *
 * These make real API calls. Run with: make test-e2e-live
 * Requires a valid API key in .env and the test gatekeeper running.
 *
 * All tests are tagged @live so they're excluded from the default run.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

/** Wait for an assistant message containing `pattern` to appear in the chat. */
async function waitForAssistantMessage(
  page: import('@playwright/test').Page,
  pattern: RegExp | string,
  timeout = 45_000
): Promise<void> {
  await expect(page.locator('#messages')).toContainText(pattern, { timeout });
}

/** Disable reasoning to keep @live responses fast and cheap. */
async function disableReasoning(page: import('@playwright/test').Page): Promise<void> {
  const toggle = page.locator('#sb-reasoning-toggle');
  if ((await toggle.innerText()).trim() === 'ON') await toggle.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
  await page.locator('#input').fill('/reset');
  await page.locator('#input').press('Enter');
  await page.waitForTimeout(500);
});

// ── Basic response ─────────────────────────────────────────────────────────────

test('@live agent responds to a simple message', async ({ page }) => {
  test.setTimeout(60_000);
  await disableReasoning(page);

  await page.locator('#input').fill('Reply with exactly this text and nothing else: INTEGRATION_TEST_OK');
  await page.locator('#input').press('Enter');

  await waitForAssistantMessage(page, 'INTEGRATION_TEST_OK');
});

// ── Context window grows ────────────────────────────────────────────────────────

test('@live context meter increases after a response', async ({ page }) => {
  test.setTimeout(60_000);
  await disableReasoning(page);

  const ctxLabel = page.locator('#sb-ctx-label');
  const before = await ctxLabel.innerText();

  await page.locator('#input').fill('Say: ok');
  await page.locator('#input').press('Enter');
  await waitForAssistantMessage(page, /\bok\b/i);

  const after = await ctxLabel.innerText();
  expect(after).not.toEqual(before);
});

// ── Cost updates ───────────────────────────────────────────────────────────────

test('@live cost badge updates after a response', async ({ page }) => {
  test.setTimeout(60_000);
  await disableReasoning(page);

  await page.locator('#input').fill('Say: cost-check');
  await page.locator('#input').press('Enter');
  await waitForAssistantMessage(page, /cost-check/i);

  await expect(page.locator('#sb-cost-value')).not.toHaveText('$0.00', { timeout: 5_000 });
});

// ── Exec permission flow ────────────────────────────────────────────────────────

test('@live exec permission modal appears for a command', async ({ page }) => {
  test.setTimeout(90_000);
  await disableReasoning(page);

  await page.locator('#input').fill(
    'Please run the shell command: echo EXEC_PERMISSION_TEST and report the output.'
  );
  await page.locator('#input').press('Enter');

  // Wait for the permission modal
  const overlay = page.locator('#perm-overlay');
  await expect(overlay).not.toHaveClass(/\bhidden\b/, { timeout: 50_000 });
  await expect(page.locator('#perm-card-detail')).toContainText(/echo/);

  // Approve
  await page.locator('#perm-approve-btn').click();
  await expect(overlay).toHaveClass(/\bhidden\b/, { timeout: 3_000 });

  // Agent reports the output
  await waitForAssistantMessage(page, /EXEC_PERMISSION_TEST/, 30_000);
});

// ── Ctrl+Enter reasoning flip ───────────────────────────────────────────────────

test('@live Ctrl+Enter sends with flipped reasoning', async ({ page }) => {
  test.setTimeout(90_000);

  // Set reasoning to OFF
  const toggle = page.locator('#sb-reasoning-toggle');
  if ((await toggle.innerText()).trim() === 'ON') await toggle.click();
  await expect(toggle).toHaveText('OFF', { timeout: 2_000 });

  // Send with Ctrl+Enter — this should flip reasoning ON for this message
  await page.locator('#input').fill('Say: ctrl-enter-test');
  await page.locator('#input').press('Control+Enter');

  // Agent responds (reasoning was flipped on just for this call)
  await waitForAssistantMessage(page, /ctrl-enter-test/i, 60_000);
});

// ── Model switching ─────────────────────────────────────────────────────────────

test('@live switching model updates label and subsequent response', async ({ page }) => {
  test.setTimeout(90_000);
  await disableReasoning(page);

  // Switch to Haiku (fastest)
  await page.locator('#sb-model-btn').click();
  const haikuOption = page.locator('#sb-model-picker .sb-model-option', { hasText: /haiku/i });
  const count = await haikuOption.count();
  if (count === 0) {
    test.skip(); // Haiku not in the model list
    return;
  }
  await haikuOption.click();
  await expect(page.locator('#sb-model-value')).toContainText(/haiku/i, { timeout: 3_000 });

  // Verify it responds
  await page.locator('#input').fill('Say: haiku-test');
  await page.locator('#input').press('Enter');
  await waitForAssistantMessage(page, /haiku-test/i, 45_000);
});
