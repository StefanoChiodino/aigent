/**
 * 24 — Context Inspector: data rendering via injected breakdown events
 *
 * 09-context-inspector.spec.ts checks open/close and basic presence.
 * This file injects a real context_breakdown event so we can assert on
 * actual bar values, message rows, summary savings, and expand panels.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const FAKE_BREAKDOWN = {
  systemBase: 4000,
  systemBaseContent: '# System\nYou are an AI agent.',
  workspaceContext: 1200,
  workspaceContent: '{"agents":"AGENTS.md content"}',
  toolDefs: 800,
  toolDefsContent: '[{"name":"exec","description":"Run commands"}]',
  messages: [
    { role: 'user', tokens: 120, preview: 'Hello!' },
    { role: 'assistant', tokens: 240, preview: 'Hi there.' },
    { role: 'tool_result', tokens: 80, preview: '{"result":"ok"}' },
  ],
  messagesTotal: 440,
  total: 6440,
};

test.describe('Context Inspector Data', () => {
  const getPage = useSharedPage();

  /**
   * Inject fake breakdown data and open the inspector.
   *
   * Opening the inspector triggers a context_breakdown_request to the server,
   * whose response would overwrite our test data. To prevent that, we wait
   * for the server response to arrive, then re-inject our fake data.
   */
  async function openWithData(
    page: import('@playwright/test').Page,
    breakdown: Record<string, unknown> = FAKE_BREAKDOWN,
  ): Promise<void> {
    // Inject breakdown data into the store
    await injectEvent({ type: 'context_breakdown', breakdown });
    // Open the inspector (the WS event no longer auto-opens it)
    await page.evaluate(() => {
      const fn = (window as Record<string, unknown>).__testSetCtxInspectorOpen;
      if (typeof fn === 'function') (fn as (open: boolean) => void)(true);
    });
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    // Wait for server's context_breakdown_request response to arrive
    await page.waitForTimeout(500);
    // Re-inject our fake data to override the server response
    await injectEvent({ type: 'context_breakdown', breakdown });
    await page.waitForTimeout(50);
  }

  // ── Summary line ──────────────────────────────────────────────────────────────

  test('summary line shows injected token total', async () => {
    const page = getPage();
    await openWithData(page);
    const summary = page.locator('#ctx-inspector-summary');
    await expect(summary).toContainText('6.4k', { timeout: 3_000 });
  });

  test('summary line shows window percentage', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('%', { timeout: 3_000 });
  });

  test('summary line shows savings when totalSummarySavedTokens is set', async () => {
    const page = getPage();
    const breakdown = { ...FAKE_BREAKDOWN, totalSummarySavedTokens: 3000, toolSummariesCount: 2 };
    await openWithData(page, breakdown);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('saved', { timeout: 3_000 });
    await expect(page.locator('#ctx-inspector-summary')).toContainText('3.0k', { timeout: 3_000 });
  });

  // ── Stacked bar ───────────────────────────────────────────────────────────────

  test('stacked bar has 4 segments', async () => {
    const page = getPage();
    await openWithData(page);
    const segments = page.locator('#ctx-stacked-bar .ctx-stacked-segment');
    await expect(segments).toHaveCount(4, { timeout: 3_000 });
  });

  test('stacked segments have non-zero widths for non-zero sections', async () => {
    const page = getPage();
    await openWithData(page);
    const segments = page.locator('#ctx-stacked-bar .ctx-stacked-segment');
    for (let i = 0; i < 4; i++) {
      const width = await segments.nth(i).evaluate(el => (el as HTMLElement).style.width);
      // All four sections have tokens, so width should be non-zero
      expect(parseFloat(width)).toBeGreaterThan(0);
    }
  });

  // ── Bar rows ──────────────────────────────────────────────────────────────────

  test('bar rows show correct section labels', async () => {
    const page = getPage();
    await openWithData(page);
    const bars = page.locator('#ctx-inspector-bars');
    await expect(bars).toContainText('System prompt', { timeout: 3_000 });
    await expect(bars).toContainText('Workspace');
    await expect(bars).toContainText('Tool definitions');
    await expect(bars).toContainText('Messages');
  });

  test('bar rows show token counts', async () => {
    const page = getPage();
    await openWithData(page);
    const bars = page.locator('#ctx-inspector-bars');
    // systemBase = 4000 → "4.0k"
    await expect(bars).toContainText('4.0k', { timeout: 3_000 });
  });

  test('clicking system prompt bar row expands its content', async () => {
    const page = getPage();
    await openWithData(page);

    const systemRow = page.locator('#ctx-inspector-bars .ctx-bar-row').nth(0);
    await systemRow.click();

    const panel = page.locator('#ctx-inspector-bars .ctx-expand-panel').first();
    await expect(panel).toBeVisible({ timeout: 2_000 });
    await expect(panel).toContainText('System');
  });

  test('clicking same bar row again collapses it', async () => {
    const page = getPage();
    await openWithData(page);

    const systemRow = page.locator('#ctx-inspector-bars .ctx-bar-row').nth(0);
    await systemRow.click();
    await expect(page.locator('#ctx-inspector-bars .ctx-expand-panel').first()).toBeVisible({ timeout: 2_000 });

    await systemRow.click();
    await expect(page.locator('#ctx-inspector-bars .ctx-expand-panel')).toHaveCount(0, { timeout: 2_000 });
  });

  // ── Message rows ──────────────────────────────────────────────────────────────

  test('message rows show injected messages', async () => {
    const page = getPage();
    await openWithData(page);
    const msgTable = page.locator('#ctx-inspector-messages');
    await expect(msgTable).toBeVisible({ timeout: 3_000 });
    // 3 messages in FAKE_BREAKDOWN
    const rows = msgTable.locator('.ctx-msg-row');
    await expect(rows).toHaveCount(3);
  });

  test('message rows show role labels', async () => {
    const page = getPage();
    await openWithData(page);
    const msgTable = page.locator('#ctx-inspector-messages');
    await expect(msgTable).toContainText('user', { timeout: 3_000 });
    await expect(msgTable).toContainText('assistant');
    // tool_result renders as "tool"
    await expect(msgTable).toContainText('tool');
  });

  test('message rows show row numbers starting from 1', async () => {
    const page = getPage();
    await openWithData(page);
    const firstIdx = page.locator('#ctx-inspector-messages .ctx-msg-idx').first();
    await expect(firstIdx).toHaveText('1', { timeout: 3_000 });
  });

  test('clicking a message row with preview expands it', async () => {
    const page = getPage();
    await openWithData(page);

    const firstRow = page.locator('#ctx-inspector-messages .ctx-msg-row').first();
    await firstRow.click();

    const panel = page.locator('#ctx-inspector-messages .ctx-expand-panel').first();
    await expect(panel).toBeVisible({ timeout: 2_000 });
    await expect(panel).toContainText('Hello!');
  });

  // ── Header updates on re-open ─────────────────────────────────────────────────

  test('inspector shows latest data when re-opened after new breakdown', async () => {
    const page = getPage();
    // First breakdown
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('6.4k', { timeout: 3_000 });

    // Close
    await page.locator('#ctx-inspector-close').click();
    await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Re-open with bigger breakdown
    const bigger = { ...FAKE_BREAKDOWN, total: 50_000, systemBase: 45_000, messagesTotal: 5_000 };
    await openWithData(page, bigger);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('50.0k', { timeout: 3_000 });
  });

  // ── Messages header ───────────────────────────────────────────────────────────

  test('messages header shows count when messages are present', async () => {
    const page = getPage();
    await openWithData(page);
    const header = page.locator('#ctx-inspector-messages-header');
    await expect(header).toContainText('3', { timeout: 3_000 });
  });

  test('messages header includes "click any row" hint when messages present', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-messages-header')).toContainText('click', { timeout: 3_000 });
  });
});
