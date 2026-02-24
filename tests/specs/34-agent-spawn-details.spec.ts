/**
 * 34 — Agent spawn details: model name and reasoning mode
 *
 * When spawn_agent or dispatch_task tool traces include model/thinking metadata,
 * the expanded tool body should display an .agent-meta row showing the model
 * name (shortened) and reasoning level.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

/** Inject a complete tool turn with optional model/thinking metadata. */
async function injectAgentTurn(
  name: string,
  input: Record<string, unknown>,
  summary: string,
  output: string,
  finalText: string,
  meta?: { model?: string; thinking?: string },
): Promise<void> {
  await injectEvent({ type: 'loading', isLoading: true });
  await injectEvent({
    type: 'tool_start',
    name,
    input: JSON.stringify(input),
    summary,
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.thinking ? { thinking: meta.thinking } : {}),
  });
  await injectEvent({ type: 'tool_output', content: output });
  await injectEvent({ type: 'tool_end' });
  await injectEvent({ type: 'text', content: finalText });
  await injectEvent({
    type: 'message',
    message: { role: 'assistant', content: finalText, timestamp: NOW },
  });
  await injectEvent({ type: 'loading', isLoading: false });
}

test.describe('Agent Spawn Details', () => {
  const getPage = useSharedPage();

  test('spawn_agent shows model and reasoning in expanded body', async () => {
    const page = getPage();
    await injectAgentTurn(
      'spawn_agent',
      { task: 'Analyze component', model: 'claude-sonnet-4-6', thinking: 'low' },
      'spawn: Analyze component',
      '[Sub-agent completed in 2 iterations]\nDone.',
      'Analysis complete.',
      { model: 'claude-sonnet-4-6', thinking: 'low' },
    );

    // Expand traces
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    // Expand the tool block
    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    // Verify agent-meta row
    const meta = block.locator('.agent-meta');
    await expect(meta).toBeVisible({ timeout: 3_000 });
    await expect(meta.locator('.agent-meta-value').first()).toContainText('sonnet 4.6');
    await expect(meta.locator('.agent-meta-value').last()).toContainText('low');
  });

  test('dispatch_task shows model and reasoning in expanded body', async () => {
    const page = getPage();
    await injectAgentTurn(
      'dispatch_task',
      { task: 'Background research', model: 'claude-haiku-4-5-20251001', thinking: 'off' },
      'dispatch: Background research',
      'Task started.',
      'Task dispatched.',
      { model: 'claude-haiku-4-5-20251001', thinking: 'off' },
    );

    // Expand traces
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    // Expand the task block
    const block = page.locator('#messages .task-block').last();
    await block.locator('.tool-header').click();

    // For haiku + thinking: off → model shown, reasoning hidden
    const meta = block.locator('.agent-meta');
    await expect(meta).toBeVisible({ timeout: 3_000 });
    await expect(meta.locator('.agent-meta-value')).toContainText('haiku 4.5');
    // "off" thinking should NOT show reasoning label
    await expect(meta.locator('.agent-meta-item')).toHaveCount(1);
  });

  test('no agent-meta row when model and thinking are absent', async () => {
    const page = getPage();
    // Regular tool — no model/thinking meta
    await injectAgentTurn(
      'read_file',
      { path: '/foo.ts' },
      'read /foo.ts',
      'file contents here',
      'Read the file.',
    );

    // Expand traces
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    // Expand tool block
    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    // No agent-meta row
    await expect(block.locator('.agent-meta')).toHaveCount(0);
  });

  test('model name is shortened correctly', async () => {
    const page = getPage();
    await injectAgentTurn(
      'spawn_agent',
      { task: 'Deep analysis', model: 'claude-opus-4-6', thinking: 'high' },
      'spawn: Deep analysis',
      '[Sub-agent completed in 5 iterations]\nResult.',
      'Done.',
      { model: 'claude-opus-4-6', thinking: 'high' },
    );

    // Expand traces
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    // Expand tool block
    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    const meta = block.locator('.agent-meta');
    await expect(meta).toBeVisible({ timeout: 3_000 });
    // "claude-opus-4-6" → "opus 4.6"
    await expect(meta.locator('.agent-meta-value').first()).toContainText('opus 4.6');
    await expect(meta.locator('.agent-meta-value').last()).toContainText('high');
  });

  test('thinking "off" hides the reasoning item', async () => {
    const page = getPage();
    await injectAgentTurn(
      'spawn_agent',
      { task: 'Quick search', model: 'claude-sonnet-4-6', thinking: 'off' },
      'spawn: Quick search',
      'Found it.',
      'Done.',
      { model: 'claude-sonnet-4-6', thinking: 'off' },
    );

    // Expand traces
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    // Expand tool block
    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    const meta = block.locator('.agent-meta');
    await expect(meta).toBeVisible({ timeout: 3_000 });
    // Only model item, no reasoning item (thinking: off is hidden)
    await expect(meta.locator('.agent-meta-item')).toHaveCount(1);
    await expect(meta.locator('.agent-meta-label')).toContainText('model');
  });

  test('agent-meta is hidden when tool body is collapsed', async () => {
    const page = getPage();
    await injectAgentTurn(
      'spawn_agent',
      { task: 'Check files', model: 'claude-sonnet-4-6', thinking: 'low' },
      'spawn: Check files',
      'Checked.',
      'Done.',
      { model: 'claude-sonnet-4-6', thinking: 'low' },
    );

    // Expand traces to see the tool block
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    // Body should be hidden (collapsed by default)
    const body = block.locator('.tool-body');
    await expect(body).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });
});
