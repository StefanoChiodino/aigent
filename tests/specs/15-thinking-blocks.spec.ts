/**
 * 15 — Thinking (reasoning) blocks in streaming messages (injected, no LLM)
 *
 * Thinking blocks are created during streaming when the agent emits
 * `thinking` events. They appear inside `.message-traces` within the streaming
 * message element and show an animated "Reasoning…" indicator while running,
 * then collapse to "💭 Reasoned" when finalized.
 *
 * Sequence to trigger:
 *   loading(true) → thinking(content) → text(content) → message → loading(false)
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

/** Inject a complete streaming turn with a thinking block then a text response. */
async function injectThinkingTurn(id: string, thinkContent: string, textContent: string): Promise<void> {
  await injectEvent({ type: 'loading', isLoading: true });
  await injectEvent({ type: 'thinking', content: thinkContent });
  await injectEvent({ type: 'text', content: textContent });
  await injectEvent({
    type: 'message',
    message: { role: 'assistant', content: textContent, timestamp: NOW },
  });
  await injectEvent({ type: 'loading', isLoading: false });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

test('thinking event creates a thinking block in the message', async ({ page }) => {
  await injectThinkingTurn('th1', 'Let me reason about this...', 'Here is my answer.');
  // After finalization the block is inside a collapsed .traces-inner, so check it exists in DOM
  const block = page.locator('#messages .thinking-block').last();
  await expect(block).toBeAttached({ timeout: 5_000 });
});

test('finalized thinking block has "done" class', async ({ page }) => {
  await injectThinkingTurn('th2', 'Reasoning content', 'Final answer.');
  const block = page.locator('#messages .thinking-block').last();
  await expect(block).toHaveClass(/\bdone\b/, { timeout: 5_000 });
});

test('finalized thinking block toggle shows "💭 Reasoned"', async ({ page }) => {
  await injectThinkingTurn('th3', 'My reasoning...', 'Answer.');
  const toggle = page.locator('#messages .thinking-block .thinking-toggle').last();
  await expect(toggle).toContainText('Reasoned', { timeout: 5_000 });
});

test('thinking body is collapsed by default after finalization', async ({ page }) => {
  await injectThinkingTurn('th4', 'Hidden thinking...', 'Visible answer.');
  const body = page.locator('#messages .thinking-block .thinking-body').last();
  await expect(body).toHaveClass(/\bhidden\b/, { timeout: 5_000 });
});

test('clicking thinking toggle reveals the thinking content', async ({ page }) => {
  const thinkContent = 'This is the secret reasoning text';
  await injectThinkingTurn('th5', thinkContent, 'Final output.');

  // After finalization, traces are collapsed under a .traces-summary button.
  // Expand the traces first, then interact with the thinking block.
  const traceSummary = page.locator('#messages .traces-summary').last();
  await expect(traceSummary).toBeVisible({ timeout: 5_000 });
  await traceSummary.click();

  const block = page.locator('#messages .thinking-block').last();
  const toggle = block.locator('.thinking-toggle');
  const body = block.locator('.thinking-body');

  // Body starts hidden (collapsed within the thinking block)
  await expect(body).toHaveClass(/\bhidden\b/, { timeout: 3_000 });

  // Click to expand
  await toggle.click();
  await expect(body).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  await expect(body).toContainText(thinkContent);
});

test('clicking thinking toggle again collapses it', async ({ page }) => {
  await injectThinkingTurn('th6', 'Collapse test content', 'Answer.');

  // Expand traces first
  const traceSummary = page.locator('#messages .traces-summary').last();
  await expect(traceSummary).toBeVisible({ timeout: 5_000 });
  await traceSummary.click();

  const block = page.locator('#messages .thinking-block').last();
  const toggle = block.locator('.thinking-toggle');
  const body = block.locator('.thinking-body');

  await toggle.click(); // expand
  await expect(body).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

  await toggle.click(); // collapse
  await expect(body).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
});

test('expanded thinking block adds "expanded" class to the block element', async ({ page }) => {
  await injectThinkingTurn('th7', 'Expanded class test', 'Answer.');

  // Expand traces first
  const traceSummary = page.locator('#messages .traces-summary').last();
  await expect(traceSummary).toBeVisible({ timeout: 5_000 });
  await traceSummary.click();

  const block = page.locator('#messages .thinking-block').last();
  const toggle = block.locator('.thinking-toggle');

  await toggle.click();
  await expect(block).toHaveClass(/\bexpanded\b/, { timeout: 3_000 });
});

test('traces summary shows "💭 reasoned" label after thinking turn', async ({ page }) => {
  await injectThinkingTurn('th8', 'Summary label test', 'Answer text.');
  // After finalization, .message-traces gets a .traces-summary toggle if there were trace blocks
  const summary = page.locator('#messages .traces-summary').last();
  await expect(summary).toBeVisible({ timeout: 5_000 });
  await expect(summary).toContainText('reasoned');
});
