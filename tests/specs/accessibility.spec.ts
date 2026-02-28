/**
 * Accessibility audit — uses axe-core to scan the UI for WCAG violations.
 *
 * Run:  npx playwright test --config tests/playwright.config.ts tests/specs/accessibility.spec.ts
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForConnected } from '../helpers/ui.js';

const SETTINGS_GROUPS = ['Provider', 'Model', 'Tools', 'Prompt', 'Services', 'Microphone', 'Context', 'Permissions', 'Fetch Permissions'];

test.describe('Accessibility audit', () => {
  test('main chat interface has no contrast violations', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa', 'wcag21aa'])
      .withRules(['color-contrast'])
      .analyze();

    if (results.violations.length > 0) {
      const summary = results.violations.map(v =>
        `${v.id}: ${v.description}\n` +
        v.nodes.map(n =>
          `  - ${n.html.slice(0, 200)}\n    ${n.failureSummary}`
        ).join('\n')
      ).join('\n\n');
      console.log('=== MAIN PAGE CONTRAST VIOLATIONS ===\n' + summary);
    }

    const totalElements = results.violations.reduce((s, v) => s + v.nodes.length, 0);
    expect(totalElements, `Found ${totalElements} contrast violations on main page`).toBe(0);
  });

  test('settings modal — all tabs scanned for contrast violations', async ({ page }) => {
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

      const results = await new AxeBuilder({ page })
        .include('#settings-modal')
        .withTags(['wcag2aa', 'wcag21aa'])
        .withRules(['color-contrast'])
        .analyze();

      if (results.violations.length > 0) {
        const nodes = results.violations.flatMap(v =>
          v.nodes.map(n => ({
            id: v.id,
            html: n.html.slice(0, 200),
            summary: n.failureSummary ?? '',
          }))
        );
        allViolations.push({ tab: group, violations: nodes });
      }
    }

    // Close settings
    await page.locator('#settings-close').click();

    // Report all violations
    if (allViolations.length > 0) {
      const report = allViolations.map(({ tab, violations }) =>
        `\n── ${tab} tab ──\n` +
        violations.map(v => `  [${v.id}] ${v.html}\n    ${v.summary}`).join('\n')
      ).join('\n');
      console.log('=== SETTINGS MODAL CONTRAST VIOLATIONS ===' + report);

      const totalElements = allViolations.reduce((s, t) => s + t.violations.length, 0);
      expect(totalElements, `Found ${totalElements} contrast violation(s) across settings tabs:\n${report}`).toBe(0);
    }
  });
});
