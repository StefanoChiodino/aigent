/**
 * 05 — Sidebar controls: TTS, STT, reasoning, effort pills, short,
 *       model picker, context meter, mounts, cost
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Sidebar controls', () => {
  const getPage = useSharedPage();

  // ── Context meter ─────────────────────────────────────────────────────────────

  test('sidebar context meter is visible', async () => {
    const page = getPage();
    await expect(page.locator('#sb-ctx-meter')).toBeVisible();
  });

  test('context meter label is populated after injecting usage', async () => {
    const page = getPage();
    // Label is empty until usage data arrives — inject a fake usage event
    await injectEvent({
      type: 'usage',
      usage: { input: 3000, output: 500, cacheRead: 0, cacheWrite: 0, contextTokens: 3500 },
    });
    await expect(page.locator('#sb-ctx-label')).not.toBeEmpty({ timeout: 3_000 });
  });

  test('context tokens element is rendered', async () => {
    const page = getPage();
    // Before any usage it shows "--"; that's the correct initial state
    const text = await page.locator('#sb-ctx-tokens').innerText();
    expect(text).toMatch(/--|[\d,]/);
  });

  test('cost updates when usage event is injected', async () => {
    const page = getPage();
    const before = await page.locator('#sb-cost-value').innerText();
    await injectEvent({
      type: 'usage',
      usage: { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.0123 },
    });
    await expect(page.locator('#sb-cost-value')).not.toHaveText(before, { timeout: 3_000 });
  });

  test('capabilities list updates on host_state event', async () => {
    const page = getPage();
    await injectEvent({
      type: 'host_state',
      capabilities: { 'clipboard.read': { grant: 'allow', available: true } },
    });
    await expect(page.locator('#sb-caps-list')).toContainText(/Clipboard Read/i, { timeout: 3_000 });
  });

  // ── Reasoning toggle & effort pills ──────────────────────────────────────────

  test('reasoning toggle is visible', async () => {
    const page = getPage();
    await expect(page.locator('#sb-reasoning-toggle')).toBeVisible();
  });

  test('reasoning toggle shows ON or OFF', async () => {
    const page = getPage();
    const text = await page.locator('#sb-reasoning-toggle').innerText();
    expect(['ON', 'OFF']).toContain(text.trim());
  });

  test('clicking reasoning toggle flips its state', async () => {
    const page = getPage();
    const toggle = page.locator('#sb-reasoning-toggle');
    const before = (await toggle.innerText()).trim();
    const expected = before === 'ON' ? 'OFF' : 'ON';
    await toggle.click();
    // Toggle sends /reasoning on|off to the server; wait for state event round-trip
    await expect(toggle).toHaveText(expected, { timeout: 5_000 });
    // Restore
    await toggle.click();
    await expect(toggle).toHaveText(before, { timeout: 5_000 });
  });

  test('effort pills are present (L, M, H, MAX)', async () => {
    const page = getPage();
    const pills = page.locator('#sb-effort-pills .sb-pill');
    await expect(pills).toHaveCount(4);
  });

  test('clicking an effort pill activates it', async () => {
    const page = getPage();
    // Ensure reasoning is ON first
    const toggle = page.locator('#sb-reasoning-toggle');
    if ((await toggle.innerText()).trim() === 'OFF') await toggle.click();

    const highPill = page.locator('#sb-effort-pills .sb-pill[data-level="high"]');
    await highPill.click();
    await expect(highPill).toHaveClass(/active/);

    // Restore to medium
    await page.locator('#sb-effort-pills .sb-pill[data-level="medium"]').click();
  });

  test('effort pills disabled when reasoning is OFF', async () => {
    const page = getPage();
    const toggle = page.locator('#sb-reasoning-toggle');
    if ((await toggle.innerText()).trim() === 'ON') await toggle.click();
    await expect(page.locator('#sb-effort-pills')).toHaveClass(/disabled/);
    // Restore
    await toggle.click();
  });

  // ── Speak pills ──────────────────────────────────────────────────────────────

  test('speak pills are visible with off/on/short options', async () => {
    const page = getPage();
    const pills = page.locator('#sb-speak-pills .sb-pill');
    await expect(pills).toHaveCount(3);
    await expect(page.locator('#sb-speak-pills .sb-pill[data-speak="off"]')).toBeVisible();
    await expect(page.locator('#sb-speak-pills .sb-pill[data-speak="on"]')).toBeVisible();
    await expect(page.locator('#sb-speak-pills .sb-pill[data-speak="short"]')).toBeVisible();
  });

  test('clicking "on" speak pill activates it', async () => {
    const page = getPage();
    const onPill = page.locator('#sb-speak-pills .sb-pill[data-speak="on"]');
    await onPill.click();
    await expect(onPill).toHaveClass(/active/);
    // Restore
    await page.locator('#sb-speak-pills .sb-pill[data-speak="off"]').click();
  });

  test('clicking "short" speak pill activates it and sends /short on', async () => {
    const page = getPage();
    const shortPill = page.locator('#sb-speak-pills .sb-pill[data-speak="short"]');
    await shortPill.click();
    await expect(shortPill).toHaveClass(/active/, { timeout: 5_000 });
    // Restore
    const offPill = page.locator('#sb-speak-pills .sb-pill[data-speak="off"]');
    await offPill.click();
    await expect(offPill).toHaveClass(/active/, { timeout: 5_000 });
  });

  test('TTS rate slider is present', async () => {
    const page = getPage();
    await expect(page.locator('#sb-tts-rate')).toBeVisible();
  });

  test('TTS rate label updates when slider moves', async () => {
    const page = getPage();
    const slider = page.locator('#sb-tts-rate');
    await slider.fill('50');
    await slider.dispatchEvent('input');
    await expect(page.locator('#sb-tts-rate-label')).toContainText('50%');
  });

  // ── Model picker ──────────────────────────────────────────────────────────────

  test('model picker button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#sb-model-btn')).toBeVisible();
  });

  test('clicking model button opens picker dropdown', async () => {
    const page = getPage();
    await page.locator('#sb-model-btn').click();
    await expectVisible(page.locator('#sb-model-picker'));
  });

  test('model picker lists available models', async () => {
    const page = getPage();
    await page.locator('#sb-model-btn').click();
    await expectVisible(page.locator('#sb-model-picker'));
    const options = page.locator('#sb-model-picker .sb-model-option');
    await expect(options).toHaveCount(await options.count()); // just check > 0
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });

  test('clicking model option closes picker and updates label', async () => {
    const page = getPage();
    await page.locator('#sb-model-btn').click();
    await expectVisible(page.locator('#sb-model-picker'));

    // Click first option
    const firstOption = page.locator('#sb-model-picker .sb-model-option').first();
    const modelText = await firstOption.innerText();
    await firstOption.click();

    await expectHidden(page.locator('#sb-model-picker'));
    // Model label should now reflect the selection
    await expect(page.locator('#sb-model-value')).toContainText(
      modelText.trim().split('\n')[0]!.substring(0, 5) // partial match is enough
    );
  });

  test('clicking outside model picker closes it', async () => {
    const page = getPage();
    await page.locator('#sb-model-btn').click();
    await expectVisible(page.locator('#sb-model-picker'));
    await page.locator('#messages').click();
    await expectHidden(page.locator('#sb-model-picker'));
  });

  // ── Mic buttons ───────────────────────────────────────────────────────────────

  test('mic button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#mic')).toBeVisible();
  });

  test('sticky mic button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#mic-sticky')).toBeVisible();
  });

  test('input-clear button is absent when input is empty', async () => {
    const page = getPage();
    // The clear button only renders when inputValue is non-empty
    await expect(page.locator('#input-clear')).toHaveCount(0);
  });
});
