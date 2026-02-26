/**
 * 43 — Streaming activity label
 *
 * When the streaming bubble is active but has no visible text yet (e.g.
 * the agent is reasoning or running a tool), the bubble shows a dimmed
 * italic status label so the user knows what is happening instead of just
 * seeing an empty pulsating cursor.
 *
 * Tests:
 *   - "reasoning…" label appears during a thinking block before text arrives
 *   - "tool_name…" label appears while a tool_start block is running
 *   - Label disappears once text content arrives
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast Streaming activity label', () => {
  const getPage = useSharedPage();

  test('shows "reasoning…" while thinking block is active and no text yet', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'thinking', content: 'Let me think...' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    const label = streamingMsg.locator('.streaming-activity');
    await expect(label).toBeVisible({ timeout: 3000 });
    await expect(label).toHaveText('reasoning…');

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('shows tool name while tool_start block is running and no text yet', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({
      type: 'tool_start',
      name: 'read_file',
      summary: 'Reading a file',
      input: '{}',
    });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    const label = streamingMsg.locator('.streaming-activity');
    await expect(label).toBeVisible({ timeout: 3000 });
    await expect(label).toHaveText('read_file…');

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('label disappears once text content arrives', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'thinking', content: 'Thinking...' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg.locator('.streaming-activity')).toBeVisible({ timeout: 3000 });

    // Text arrives — label should vanish
    await injectEvent({ type: 'text', content: 'Here is my response.' });
    await expect(streamingMsg.locator('.streaming-activity')).not.toBeAttached({ timeout: 3000 });

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });
});
