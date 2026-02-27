/**
 * 16b — Tool result images in trace blocks (injected, no LLM)
 *
 * When a tool returns images (e.g. screenshot, request_screenshot, host clipboard),
 * they should be rendered as <img> elements inside the expanded tool body.
 *
 * Sequence:
 *   loading(true) → tool_start → tool_output → tool_images → tool_end
 *   → text → message → loading(false)
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

// Minimal valid 1x1 red PNG (base64)
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Inject a tool turn that includes an image result. */
async function injectToolTurnWithImage(
  name: string,
  input: string,
  summary: string,
  textOutput: string,
  imageData: string,
  mediaType: string,
  finalText: string,
): Promise<void> {
  await injectEvent({ type: 'loading', isLoading: true });
  await injectEvent({ type: 'tool_start', name, input, summary });
  if (textOutput) {
    await injectEvent({ type: 'tool_output', content: textOutput });
  }
  await injectEvent({ type: 'tool_images', images: [{ mediaType, data: imageData }] });
  await injectEvent({ type: 'tool_end' });
  await injectEvent({ type: 'text', content: finalText });
  await injectEvent({
    type: 'message',
    message: { role: 'assistant', content: finalText, timestamp: NOW },
  });
  await injectEvent({ type: 'loading', isLoading: false });
}

test.describe('@fast Tool Images', () => {
  const getPage = useSharedPage();

  test('tool with images shows image in expanded tool body', async () => {
    const page = getPage();
    await injectToolTurnWithImage(
      'screenshot', '{}', 'screenshot', 'Screenshot captured (100 bytes)',
      TINY_PNG, 'image/png', 'Here is the screenshot.',
    );

    // Expand traces
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    // Expand the tool block
    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    // Image should be rendered
    const img = block.locator('.tool-result-image');
    await expect(img).toBeAttached({ timeout: 3_000 });
    const src = await img.getAttribute('src');
    expect(src).toContain('data:image/png;base64,');
  });

  test('tool images container has correct class', async () => {
    const page = getPage();
    await injectToolTurnWithImage(
      'request_screenshot', '{}', 'request_screenshot', '',
      TINY_PNG, 'image/png', 'Screenshot taken.',
    );

    // Expand traces + tool body
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    const container = block.locator('.tool-images');
    await expect(container).toBeAttached({ timeout: 3_000 });
  });

  test('tool with text output AND images shows both', async () => {
    const page = getPage();
    const output = 'Screenshot captured (42 bytes, 100x100)';
    await injectToolTurnWithImage(
      'screenshot', '{}', 'screenshot', output,
      TINY_PNG, 'image/png', 'Done.',
    );

    // Expand traces + tool body
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    // Both text output and image should be present
    await expect(block.locator('.tool-output')).toContainText(output, { timeout: 3_000 });
    await expect(block.locator('.tool-result-image')).toBeAttached({ timeout: 3_000 });
  });

  test('tool without images does not render image container', async () => {
    const page = getPage();
    // Regular tool turn without images
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'tool_start', name: 'read_file', input: '{"path":"/test.ts"}', summary: 'read_file' });
    await injectEvent({ type: 'tool_output', content: 'file contents' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({ type: 'text', content: 'Read the file.' });
    await injectEvent({
      type: 'message',
      message: { role: 'assistant', content: 'Read the file.', timestamp: NOW },
    });
    await injectEvent({ type: 'loading', isLoading: false });

    // Expand traces + tool body
    const traceSummary = page.locator('#messages .traces-summary').last();
    await expect(traceSummary).toBeVisible({ timeout: 5_000 });
    await traceSummary.click();

    const block = page.locator('#messages .tool-block').last();
    await block.locator('.tool-header').click();

    // No .tool-images container should exist
    await expect(block.locator('.tool-images')).toHaveCount(0);
  });
});
