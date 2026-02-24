/**
 * 29 — Context Inspector: comprehensive end-to-end tests
 *
 * Tests the full lifecycle of the context inspector:
 *   - Opening via sidebar, header, and /context command
 *   - Data loading from the real backend
 *   - Data rendering with injected breakdowns
 *   - Expand/collapse bar rows and message rows
 *   - Closing via button, Escape, and click-outside
 *   - Edge cases: empty messages, large tokens, summarization savings
 *
 * Uses a single shared page for all tests to avoid the gatekeeper crashing
 * between describe blocks causing cascading ERR_CONNECTION_REFUSED failures.
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
  await injectEvent({ type: 'context_breakdown', breakdown });
  await page.evaluate(() => {
    const fn = (window as Record<string, unknown>).__testSetCtxInspectorOpen;
    if (typeof fn === 'function') (fn as (open: boolean) => void)(true);
  });
  await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  // Wait for server response, then re-inject our fake data
  await page.waitForTimeout(500);
  await injectEvent({ type: 'context_breakdown', breakdown });
  await page.waitForTimeout(50);
}

async function closeInspector(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#ctx-inspector-close').click();
  await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
}

test.describe('Context Inspector E2E', () => {
  const getPage = useSharedPage();

  // ── Open / Close ────────────────────────────────────────────────────────────

  test('clicking sidebar context meter opens inspector', async () => {
    const page = getPage();
    await page.locator('#sb-ctx-meter').click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('close button hides inspector', async () => {
    const page = getPage();
    await page.locator('#sb-ctx-meter').click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await page.locator('#ctx-inspector-close').click();
    await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('Escape key closes inspector', async () => {
    const page = getPage();
    await page.locator('#sb-ctx-meter').click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('clicking outside overlay closes inspector', async () => {
    const page = getPage();
    await page.locator('#sb-ctx-meter').click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await page.locator('#ctx-inspector-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('/context command opens inspector', async () => {
    const page = getPage();
    await page.locator('#input').fill('/context');
    await page.keyboard.press('Enter');
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  // ── Live Backend Data ───────────────────────────────────────────────────────

  /** Open inspector via sidebar and wait for backend data to arrive. */
  async function openAndWaitForBackend(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#sb-ctx-meter').click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    // Wait for summary (proves backend responded with breakdown data)
    await expect(page.locator('#ctx-inspector-summary')).toBeVisible({ timeout: 12_000 });
  }

  test('loads data from backend (not stuck on Loading)', async () => {
    const page = getPage();
    await openAndWaitForBackend(page);
    const text = await page.locator('#ctx-inspector-summary').innerText();
    expect(text).toMatch(/\d/);
  });

  test('shows stacked bar from backend', async () => {
    const page = getPage();
    await openAndWaitForBackend(page);
    await expect(page.locator('#ctx-stacked-bar')).toBeVisible({ timeout: 2_000 });
  });

  test('shows bar rows from backend', async () => {
    const page = getPage();
    await openAndWaitForBackend(page);
    const bars = page.locator('#ctx-inspector-bars');
    await expect(bars).toBeVisible({ timeout: 2_000 });
    expect(await bars.locator('.ctx-bar-row').count()).toBeGreaterThan(0);
  });

  test('messages section is present from backend', async () => {
    const page = getPage();
    await openAndWaitForBackend(page);
    await expect(page.locator('#ctx-inspector-messages-header')).toBeAttached({ timeout: 2_000 });
    await expect(page.locator('#ctx-inspector-messages')).toBeAttached();
  });

  test('bar rows are expandable from backend data', async () => {
    const page = getPage();
    await openAndWaitForBackend(page);
    const firstRow = page.locator('#ctx-inspector-bars .ctx-bar-row').first();
    await firstRow.click();
    await expect(page.locator('#ctx-inspector-bars .ctx-expand-panel').first()).toBeVisible({ timeout: 2_000 });
  });

  // ── Injected Data: Summary ────────────────────────────────────────────────

  test('summary shows injected token total', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('6.4k', { timeout: 3_000 });
  });

  test('summary shows window percentage', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('%', { timeout: 3_000 });
  });

  test('summary shows savings when totalSummarySavedTokens is set', async () => {
    const page = getPage();
    const bd = { ...FAKE_BREAKDOWN, totalSummarySavedTokens: 3000, toolSummariesCount: 2 };
    await openWithData(page, bd);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('saved', { timeout: 3_000 });
    await expect(page.locator('#ctx-inspector-summary')).toContainText('3.0k', { timeout: 3_000 });
  });

  // ── Injected Data: Stacked Bar ────────────────────────────────────────────

  test('stacked bar has 4 segments', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-stacked-bar .ctx-stacked-segment')).toHaveCount(4, { timeout: 3_000 });
  });

  test('stacked segments have non-zero widths', async () => {
    const page = getPage();
    await openWithData(page);
    const segments = page.locator('#ctx-stacked-bar .ctx-stacked-segment');
    for (let i = 0; i < 4; i++) {
      const width = await segments.nth(i).evaluate(el => (el as HTMLElement).style.width);
      expect(parseFloat(width)).toBeGreaterThan(0);
    }
  });

  // ── Injected Data: Bar Rows ───────────────────────────────────────────────

  test('bar rows show all section labels', async () => {
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
    await expect(page.locator('#ctx-inspector-bars')).toContainText('4.0k', { timeout: 3_000 });
  });

  test('clicking bar row expands content panel', async () => {
    const page = getPage();
    await openWithData(page);
    await page.locator('#ctx-inspector-bars .ctx-bar-row').nth(0).click();
    const panel = page.locator('#ctx-inspector-bars .ctx-expand-panel').first();
    await expect(panel).toBeVisible({ timeout: 2_000 });
    await expect(panel).toContainText('System');
  });

  test('clicking expanded bar row collapses it', async () => {
    const page = getPage();
    await openWithData(page);
    const row = page.locator('#ctx-inspector-bars .ctx-bar-row').nth(0);
    await row.click();
    await expect(page.locator('#ctx-inspector-bars .ctx-expand-panel').first()).toBeVisible({ timeout: 2_000 });
    await row.click();
    await expect(page.locator('#ctx-inspector-bars .ctx-expand-panel')).toHaveCount(0, { timeout: 2_000 });
  });

  // ── Injected Data: Message Rows ───────────────────────────────────────────

  test('message rows render correct count', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-messages .ctx-msg-row')).toHaveCount(3, { timeout: 3_000 });
  });

  test('message rows show role labels', async () => {
    const page = getPage();
    await openWithData(page);
    const table = page.locator('#ctx-inspector-messages');
    await expect(table).toContainText('user', { timeout: 3_000 });
    await expect(table).toContainText('assistant');
    await expect(table).toContainText('tool');
  });

  test('message rows start numbering from 1', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-messages .ctx-msg-idx').first()).toHaveText('1', { timeout: 3_000 });
  });

  test('clicking message row expands preview', async () => {
    const page = getPage();
    await openWithData(page);
    await page.locator('#ctx-inspector-messages .ctx-msg-row').first().click();
    const panel = page.locator('#ctx-inspector-messages .ctx-expand-panel').first();
    await expect(panel).toBeVisible({ timeout: 2_000 });
    await expect(panel).toContainText('Hello!');
  });

  test('messages header shows count', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-messages-header')).toContainText('3', { timeout: 3_000 });
  });

  test('messages header includes click hint', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-messages-header')).toContainText('click', { timeout: 3_000 });
  });

  // ── Re-open with new data ─────────────────────────────────────────────────

  test('shows updated data when re-opened with new breakdown', async () => {
    const page = getPage();
    await openWithData(page);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('6.4k', { timeout: 3_000 });
    await closeInspector(page);
    const bigger = { ...FAKE_BREAKDOWN, total: 50_000, systemBase: 45_000, messagesTotal: 5_000 };
    await openWithData(page, bigger);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('50.0k', { timeout: 3_000 });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────────

  test('handles empty messages array', async () => {
    const page = getPage();
    const bd = { ...FAKE_BREAKDOWN, messages: [], messagesTotal: 0 };
    await openWithData(page, bd);
    await expect(page.locator('#ctx-inspector-summary')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#ctx-stacked-bar')).toBeVisible();
    await expect(page.locator('#ctx-inspector-messages .ctx-msg-row')).toHaveCount(0);
  });

  test('handles zero total tokens', async () => {
    const page = getPage();
    const bd = { systemBase: 0, workspaceContext: 0, toolDefs: 0, messages: [], messagesTotal: 0, total: 0 };
    await openWithData(page, bd);
    await expect(page.locator('#ctx-inspector-summary')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#ctx-inspector-summary')).toContainText('0');
  });

  test('handles large token counts', async () => {
    const page = getPage();
    const bd = { ...FAKE_BREAKDOWN, total: 180_000, systemBase: 100_000 };
    await openWithData(page, bd);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('180.0k', { timeout: 3_000 });
    await expect(page.locator('#ctx-inspector-summary')).toContainText('90%');
  });

  test('handles breakdown without optional content fields', async () => {
    const page = getPage();
    const bd = {
      systemBase: 1000, workspaceContext: 500, toolDefs: 300,
      messages: [{ role: 'user', tokens: 50 }],
      messagesTotal: 50, total: 1850,
    };
    await openWithData(page, bd);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('1.9k', { timeout: 3_000 });
    await expect(page.locator('#ctx-inspector-bars .ctx-bar-row').nth(0)).not.toHaveClass(/ctx-clickable/);
  });

  test('handles tool_result with summaryRecord', async () => {
    const page = getPage();
    const bd = {
      ...FAKE_BREAKDOWN,
      messages: [{
        role: 'tool_result', tokens: 100, preview: '{"result":"summarized"}',
        summaryRecord: {
          toolCallId: 'tc_1', toolName: 'exec',
          originalTokens: 5000, summarizedTokens: 100, savedTokens: 4900,
          fullOutputPath: '/tmp/aigent/tool-results/tc_1.txt',
          summary: 'Command output summarized.',
        },
      }],
      messagesTotal: 100, total: 6100,
      totalSummarySavedTokens: 4900, toolSummariesCount: 1,
    };
    await openWithData(page, bd);
    await expect(page.locator('#ctx-inspector-summary')).toContainText('saved', { timeout: 3_000 });
    await expect(page.locator('#ctx-inspector-messages .ctx-msg-role').first()).toContainText('✦');
  });
});
