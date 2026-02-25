/**
 * 16 — Tool trace blocks in streaming messages (injected, no LLM)
 *
 * Tool calls are rendered as `.tool-block` elements inside `.message-traces`.
 * They show an icon, tool name, optional summary, expand hint, and a body with
 * input JSON and output text.
 *
 * Sequence to trigger:
 *   loading(true) → tool_start(name, input, summary) → tool_output(content)
 *   → tool_end → text(content) → message → loading(false)
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

/** Inject a complete turn with a single tool call and a final text response. */
async function injectToolTurn(
  name: string,
  input: string,
  summary: string,
  output: string,
  finalText: string,
): Promise<void> {
  await injectEvent({ type: 'loading', isLoading: true });
  await injectEvent({ type: 'tool_start', name, input, summary });
  await injectEvent({ type: 'tool_output', content: output });
  await injectEvent({ type: 'tool_end' });
  await injectEvent({ type: 'text', content: finalText });
  await injectEvent({
    type: 'message',
    message: { role: 'assistant', content: finalText, timestamp: NOW },
  });
  await injectEvent({ type: 'loading', isLoading: false });
}

test.describe('@fast Tool Traces', () => {
  const getPage = useSharedPage();

  test('tool_start creates a tool block in the message', async () => {
    const page = getPage();
    await injectToolTurn('read_file', '{"path":"/foo.ts"}', 'read_file', 'file contents', 'Done.');
    // After finalization the block is inside a collapsed .traces-inner, so check it exists in DOM
    const block = page.locator('#messages .tool-block').last();
    await expect(block).toBeAttached({ timeout: 5_000 });
  });

  test('tool block shows the tool name', async () => {
    const page = getPage();
    await injectToolTurn('exec', '{"command":"ls"}', 'exec', 'file.ts\n', 'Listed.');
    const block = page.locator('#messages .tool-block').last();
    await expect(block.locator('.tool-name')).toContainText('Exec', { timeout: 5_000 });
  });

  test('tool block shows a summary when provided', async () => {
    const page = getPage();
    await injectToolTurn('read_file', '{"path":"/foo.ts"}', 'Reading /foo.ts', 'contents', 'Done.');
    const block = page.locator('#messages .tool-block').last();
    await expect(block.locator('.tool-summary')).toContainText('Reading /foo.ts', { timeout: 5_000 });
  });

  test('tool block has "done" class after tool_end', async () => {
    const page = getPage();
    await injectToolTurn('grep', '{"pattern":"fn"}', 'grep', 'results', 'Found it.');
    const block = page.locator('#messages .tool-block').last();
    await expect(block).toHaveClass(/\bdone\b/, { timeout: 5_000 });
  });

  test('tool body is collapsed by default', async () => {
    const page = getPage();
    await injectToolTurn('glob', '{"pattern":"*.ts"}', 'glob', 'a.ts\nb.ts', 'Checked.');
    const body = page.locator('#messages .tool-block .tool-body').last();
    await expect(body).toHaveClass(/\bhidden\b/, { timeout: 5_000 });
  });

  test('clicking tool header expands the tool body', async () => {
    const page = getPage();
    await injectToolTurn('read_file', '{"path":"/bar.ts"}', 'read_file', 'bar content', 'Read.');

    // Expand traces first — after finalization traces are collapsed under .traces-summary
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    const header = block.locator('.tool-header');
    const body = block.locator('.tool-body');

    await expect(body).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await header.click();
    await expect(body).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('expanded tool body shows input JSON', async () => {
    const page = getPage();
    const input = '{"path":"/show-input.ts"}';
    await injectToolTurn('read_file', input, 'read_file', 'result', 'Done.');

    // Expand traces first
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();
    await expect(block.locator('.tool-input')).toContainText('show-input.ts', { timeout: 3_000 });
  });

  test('expanded tool body shows tool output', async () => {
    const page = getPage();
    const output = 'TOOL_OUTPUT_CONTENT_12345';
    await injectToolTurn('exec', '{"command":"echo test"}', 'exec', output, 'Done.');

    // Expand traces first
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();
    await expect(block.locator('.tool-output')).toContainText(output, { timeout: 3_000 });
  });

  test('clicking tool header again collapses it', async () => {
    const page = getPage();
    await injectToolTurn('fetch', '{"url":"https://example.com"}', 'fetch', '<html>', 'Fetched.');

    // Expand traces first
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    const header = block.locator('.tool-header');
    const body = block.locator('.tool-body');

    await header.click(); // expand
    await expect(body).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await header.click(); // collapse
    await expect(body).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('expanded tool block adds "expanded" class', async () => {
    const page = getPage();
    await injectToolTurn('glob', '{"pattern":"**"}', 'glob', 'results', 'Done.');

    // Expand traces first
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();
    await expect(block).toHaveClass(/\bexpanded\b/, { timeout: 3_000 });
  });

  test('traces summary shows tool count after a tool turn', async () => {
    const page = getPage();
    await injectToolTurn('read_file', '{"path":"/x.ts"}', 'read_file', 'content', 'Answer.');
    const summary = page.locator('#messages .traces-summary').last();
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await expect(summary).toContainText('1 tool');
  });

  test('dispatch_task tool renders as task-block instead of tool-block', async () => {
    const page = getPage();
    // Count tool-blocks before to establish baseline
    const toolBlocksBefore = await page.locator('#messages .tool-block').count();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'tool_start', name: 'dispatch_task', input: '{"description":"bg-task"}', summary: 'Dispatching task' });
    await injectEvent({ type: 'tool_output', content: 'Task started' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({ type: 'text', content: 'Task dispatched.' });
    await injectEvent({
      type: 'message',
      message: { role: 'assistant', content: 'Task dispatched.', timestamp: NOW },
    });
    await injectEvent({ type: 'loading', isLoading: false });

    // A new task-block should have been added
    const taskBlock = page.locator('#messages .task-block').last();
    await expect(taskBlock).toBeAttached({ timeout: 5_000 });

    // No new tool-block should have been added (count should not have increased)
    await expect(page.locator('#messages .tool-block')).toHaveCount(toolBlocksBefore, { timeout: 3_000 });
  });
});
