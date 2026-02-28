/**
 * Accessibility audit — uses axe-core to scan all modals/dialogs for WCAG violations.
 *
 * Covered: Settings modal (all tabs), Shortcuts modal, Permission modal (exec, patch),
 * Context inspector, Task result panel.
 *
 * The sidebar and empty state overlay an animated canvas/bokeh background,
 * making contrast non-deterministic. These areas use an intentionally dim
 * aesthetic and are excluded from strict contrast checks.
 *
 * Run:  npx playwright test --config tests/playwright.config.ts tests/specs/accessibility.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForConnected } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';

const SETTINGS_GROUPS = [
  'Provider', 'Model', 'Appearance', 'Tools', 'Prompt', 'Services',
  'Microphone', 'Context', 'Permissions', 'Fetch Permissions',
  'File Permissions', 'Debug',
];

/** Run axe color-contrast on a selector, return violation details. */
async function checkContrast(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2aa', 'wcag21aa'])
    .withRules(['color-contrast'])
    .analyze();

  return results.violations.flatMap(v =>
    v.nodes.map(n => ({
      id: v.id,
      html: n.html.slice(0, 200),
      summary: n.failureSummary ?? '',
    }))
  );
}

/** Assert zero contrast violations, with a descriptive report on failure. */
function assertNoViolations(violations: { id: string; html: string; summary: string }[], label: string) {
  if (violations.length === 0) return;
  const report = violations.map(v => `  [${v.id}] ${v.html}\n    ${v.summary}`).join('\n');
  console.log(`=== ${label} CONTRAST VIOLATIONS ===\n${report}`);
  expect(violations.length, `Found ${violations.length} contrast violation(s) in ${label}:\n${report}`).toBe(0);
}

test.describe('Accessibility: color contrast audit', () => {

  // ── Settings modal ────────────────────────────────────────────────────────────

  test('settings modal — all tabs', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const allViolations: { tab: string; violations: { id: string; html: string; summary: string }[] }[] = [];

    for (const group of SETTINGS_GROUPS) {
      const navBtn = page.locator('#settings-nav .settings-nav-item', { hasText: new RegExp(`^${group}$`) });
      if (await navBtn.count() === 0) continue;
      await navBtn.click();
      await page.waitForTimeout(200);

      const violations = await checkContrast(page, '#settings-modal');
      if (violations.length > 0) {
        allViolations.push({ tab: group, violations });
      }
    }

    await page.locator('#settings-close').click();

    if (allViolations.length > 0) {
      const report = allViolations.map(({ tab, violations }) =>
        `\n── ${tab} tab ──\n` +
        violations.map(v => `  [${v.id}] ${v.html}\n    ${v.summary}`).join('\n')
      ).join('\n');
      console.log('=== SETTINGS MODAL CONTRAST VIOLATIONS ===' + report);
      const total = allViolations.reduce((s, t) => s + t.violations.length, 0);
      expect(total, `Found ${total} contrast violation(s) across settings tabs:\n${report}`).toBe(0);
    }
  });

  // ── Shortcuts modal ───────────────────────────────────────────────────────────

  test('shortcuts modal', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    await page.locator('#shortcuts-btn').click();
    await expect(page.locator('#shortcuts-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const violations = await checkContrast(page, '#shortcuts-modal');
    await page.locator('#shortcuts-close').click();

    assertNoViolations(violations, 'Shortcuts modal');
  });

  // ── Permission modal (exec) ───────────────────────────────────────────────────

  test('permission modal — exec request', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    await injectEvent({ type: 'exec_request', id: 'a11y-exec-1', command: 'echo accessibility-test' });
    await expect(page.locator('#perm-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const violations = await checkContrast(page, '#perm-card');
    await page.locator('#perm-deny-btn').click();

    assertNoViolations(violations, 'Permission modal (exec)');
  });

  // ── Permission modal (patch / diff viewer) ────────────────────────────────────

  test('permission modal — patch request with diff', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    const diff = `--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n export { x };\n`;
    await injectEvent({ type: 'patch_request', id: 'a11y-patch-1', diff, reason: 'Accessibility test patch' });
    await expect(page.locator('#perm-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    // Wait for diff to render
    await page.waitForTimeout(300);

    const violations = await checkContrast(page, '#perm-card');
    await page.locator('#perm-deny-btn').click();

    assertNoViolations(violations, 'Permission modal (patch)');
  });

  // ── Context inspector ─────────────────────────────────────────────────────────

  test('context inspector', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    // Inject fake breakdown data
    const breakdown = {
      systemBase: 4000,
      systemBaseContent: '# System\nYou are an AI agent.',
      workspaceContext: 1200,
      workspaceContent: '{"agents":"AGENTS.md content"}',
      toolDefs: 800,
      toolDefsContent: '[{"name":"exec","description":"Run commands"}]',
      messages: [
        { role: 'user', tokens: 120, preview: 'Hello!' },
        { role: 'assistant', tokens: 240, preview: 'Hi there.' },
      ],
      messagesTotal: 360,
      total: 6360,
    };

    await injectEvent({ type: 'context_breakdown', breakdown });
    await page.evaluate(() => {
      const fn = (window as Record<string, unknown>).__testSetCtxInspectorOpen;
      if (typeof fn === 'function') (fn as (open: boolean) => void)(true);
    });
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

    // Wait for data to load, then re-inject to control content
    await page.waitForFunction(() => {
      const store = (window as Record<string, unknown>).__zustand_ui as { getState: () => { contextBreakdown: unknown } } | undefined;
      return store?.getState()?.contextBreakdown != null;
    }, undefined, { timeout: 3_000 });
    await injectEvent({ type: 'context_breakdown', breakdown });
    await page.waitForTimeout(200);

    const violations = await checkContrast(page, '#ctx-inspector-modal');
    await page.locator('#ctx-inspector-close').click();

    assertNoViolations(violations, 'Context inspector');
  });

  // ── Task result panel ─────────────────────────────────────────────────────────

  test('task result panel', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    const now = new Date().toISOString();
    await injectEvent({
      type: 'task_update',
      task: {
        id: 'a11y-task-1',
        description: 'Accessibility check task',
        status: 'completed',
        startedAt: now,
        completedAt: now,
        delivery: 'user-pull',
        result: 'All checks passed. No issues found in the codebase.',
      },
    });

    const item = page.locator('#sb-tasks-list .task-item-pull', { hasText: 'Accessibility check task' });
    await expect(item).toBeVisible({ timeout: 3_000 });
    await item.click({ force: true });
    await expect(page.locator('#task-result-panel')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

    const violations = await checkContrast(page, '#task-result-panel');
    await page.locator('.task-result-defer').click();

    assertNoViolations(violations, 'Task result panel');
  });
});
