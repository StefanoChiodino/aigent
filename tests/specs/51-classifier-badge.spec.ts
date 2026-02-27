/**
 * 51 — Classifier decision badge on tool traces (injected, no LLM)
 *
 * When the gatekeeper auto-handles a command (tier 1/2/3), a classifier_decision
 * event is sent to the web UI. This attaches a badge to the last tool trace
 * showing the tier and reason on hover.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

test.describe('@fast Classifier Badge', () => {
  const getPage = useSharedPage();

  test('classifier_decision attaches badge to current tool trace', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'tool_start', name: 'exec', input: '{"command":"ls"}', summary: 'ls' });
    // Classifier decision arrives while tool is running
    await injectEvent({ type: 'classifier_decision', tier: 2, action: 'allow', reason: 'Allowed by policy' });
    await injectEvent({ type: 'tool_output', content: 'file.ts\n' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({ type: 'text', content: 'Done.' });
    await injectEvent({ type: 'message', message: { role: 'assistant', content: 'Done.', timestamp: NOW } });
    await injectEvent({ type: 'loading', isLoading: false });

    // Expand traces to see the tool block
    const summary = page.locator('#messages .traces-summary').last();
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await summary.click();

    const badge = page.locator('#messages .classifier-badge').last();
    await expect(badge).toBeAttached({ timeout: 3_000 });
  });

  test('badge shows shield emoji for allow action', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'tool_start', name: 'exec', input: '{"command":"npm test"}', summary: 'npm test' });
    await injectEvent({ type: 'classifier_decision', tier: 3, action: 'allow', reason: 'Safe dev command' });
    await injectEvent({ type: 'tool_output', content: 'ok\n' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({ type: 'text', content: 'Tests pass.' });
    await injectEvent({ type: 'message', message: { role: 'assistant', content: 'Tests pass.', timestamp: NOW } });
    await injectEvent({ type: 'loading', isLoading: false });

    const summary = page.locator('#messages .traces-summary').last();
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await summary.click();

    const badge = page.locator('#messages .classifier-badge').last();
    await expect(badge).toContainText('🛡️', { timeout: 3_000 });
  });

  test('badge title contains tier and reason for hover tooltip', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'tool_start', name: 'exec', input: '{"command":"make build"}', summary: 'make build' });
    await injectEvent({ type: 'classifier_decision', tier: 3, action: 'allow', reason: 'Standard build command' });
    await injectEvent({ type: 'tool_output', content: 'built\n' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({ type: 'text', content: 'Built.' });
    await injectEvent({ type: 'message', message: { role: 'assistant', content: 'Built.', timestamp: NOW } });
    await injectEvent({ type: 'loading', isLoading: false });

    const summary = page.locator('#messages .traces-summary').last();
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await summary.click();

    const badge = page.locator('#messages .classifier-badge').last();
    const title = await badge.getAttribute('title');
    expect(title).toContain('T3');
    expect(title).toContain('Standard build command');
  });

  test('no badge appears when no classifier_decision is sent', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'tool_start', name: 'read_file', input: '{"path":"/foo.ts"}', summary: 'read_file' });
    await injectEvent({ type: 'tool_output', content: 'content\n' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({ type: 'text', content: 'Read.' });
    await injectEvent({ type: 'message', message: { role: 'assistant', content: 'Read.', timestamp: NOW } });
    await injectEvent({ type: 'loading', isLoading: false });

    const summary = page.locator('#messages .traces-summary').last();
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await summary.click();

    const block = page.locator('#messages .tool-block').last();
    await expect(block).toBeAttached({ timeout: 3_000 });
    const badges = block.locator('.classifier-badge');
    await expect(badges).toHaveCount(0);
  });
});
