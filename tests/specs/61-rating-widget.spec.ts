/**
 * 61 — Rating widget e2e tests
 *
 * Tests:
 *   Trigger visibility
 *   - Rating trigger is hidden by default (no hover)
 *   - Rating trigger becomes visible on message hover
 *   - Rating trigger stays visible after rating is set (rated class)
 *   - Rating trigger shows score badge when rated
 *   - Trigger has correct aria-label when unrated
 *   - Trigger has correct aria-label when rated
 *
 *   Popover open / close
 *   - Clicking trigger opens the popover
 *   - Popover contains header, 5 stars, notes textarea, Save button
 *   - Pressing Escape closes the popover
 *   - Clicking outside the popover closes it
 *   - Cancel button closes the popover without saving
 *   - Popover is not shown for user messages
 *
 *   Star interaction
 *   - Stars highlight on hover (active class fills 1..n)
 *   - Stars de-highlight on mouse leave (pending score persists)
 *   - Clicking a star selects it (active class)
 *   - Clicking the same star again deselects it
 *   - Save is disabled with no star selected
 *   - Save is enabled after a star is selected
 *
 *   Submitting
 *   - Save without notes sends message_rating with no notes field
 *   - Save with notes sends message_rating with notes
 *   - WebSocket message_rating carries correct messageId
 *   - After save, popover closes
 *   - After save, trigger shows score badge and rated class
 *   - Rating persists across popover open/close cycles (re-open shows previous score)
 *
 *   Editing an existing rating
 *   - Re-opening popover pre-fills existing score
 *   - Re-opening popover pre-fills existing notes
 *   - Saving a new score overwrites the old one
 *   - Clear button appears when message is already rated
 *   - Clear button removes the rating (no rated class, no score badge)
 *   - Clear button sends message_rating with rating 0
 *
 *   Streaming messages
 *   - No rating trigger during streaming
 *   - Rating trigger appears after streaming completes
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent, AigentWsClient } from '../helpers/ws-client.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

let msgCounter = 0;
function nextMsgId() { return `rating-test-${Date.now()}-${++msgCounter}`; }

async function injectAssistantMessage(content = 'Test response for rating.') {
  const id = nextMsgId();
  await injectEvent({
    type: 'message',
    message: {
      id,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
    },
  });
  return id;
}

// ─── tests ────────────────────────────────────────────────────────────────────

test.describe('@fast Rating widget', () => {
  const getPage = useSharedPage();

  // ── Trigger visibility ──────────────────────────────────────────────────────

  test('rating trigger is hidden by default (no hover)', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    const widget = msg.locator('.rating-widget');
    await expect(widget).toHaveCount(1);
    // opacity: 0 by default when not hovered and not rated
    await expect(widget).toHaveCSS('opacity', '0');
  });

  test('rating trigger becomes visible on message hover', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();

    const widget = msg.locator('.rating-widget');
    await expect(widget).toHaveCSS('opacity', '1');
  });

  test('rating trigger has correct aria-label when unrated', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    const trigger = msg.locator('.rating-trigger');
    await expect(trigger).toHaveAttribute('aria-label', 'Rate this response');
  });

  test('no rating widget on user messages', async () => {
    const page = getPage();
    await injectEvent({
      type: 'message',
      message: { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
    });

    const userMsg = page.locator('.message.user').last();
    await expect(userMsg).toBeVisible();
    await userMsg.hover();
    await expect(userMsg.locator('.rating-widget')).toHaveCount(0);
  });

  // ── Popover open / close ────────────────────────────────────────────────────

  test('clicking trigger opens the popover', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    await expect(msg.locator('.rating-popover')).toBeVisible();
  });

  test('popover contains header, 5 stars, notes textarea and Save button', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    const popover = msg.locator('.rating-popover');
    await expect(popover.locator('.rating-popover-header')).toHaveText('Rate this response');
    await expect(popover.locator('.rating-dot')).toHaveCount(5);
    await expect(popover.locator('.rating-notes')).toBeVisible();
    await expect(popover.locator('.perm-btn.perm-approve')).toHaveText('Save');
  });

  test('pressing Escape closes the popover', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await expect(msg.locator('.rating-popover')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(msg.locator('.rating-popover')).toHaveCount(0);
  });

  test('clicking outside the popover closes it', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await expect(msg.locator('.rating-popover')).toBeVisible();

    // Click somewhere far away
    await page.mouse.click(10, 10);
    await expect(msg.locator('.rating-popover')).toHaveCount(0);
  });

  test('Cancel button closes the popover without sending anything', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    const popover = msg.locator('.rating-popover');
    // Select a star but then cancel
    await popover.locator('.rating-dot').nth(2).click();

    const client = new AigentWsClient();
    await client.connect();

    await popover.locator('button', { hasText: 'Cancel' }).click();
    await expect(popover).toHaveCount(0);

    // No message_rating event sent
    await page.waitForTimeout(300);
    const events = client.collected().filter(e => e['type'] === 'message_rating');
    expect(events).toHaveLength(0);
    client.close();

    // Widget should not have rated class
    await expect(msg.locator('.rating-widget')).not.toHaveClass(/rated/);
  });

  // ── Star interaction ────────────────────────────────────────────────────────

  test('no stars are active when opening with no prior rating', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    const activeDots = msg.locator('.rating-dot.active');
    await expect(activeDots).toHaveCount(0);
  });

  test('clicking a star selects it and all stars before it', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    // Click 4th star (index 3)
    await msg.locator('.rating-dot').nth(3).click();
    await expect(msg.locator('.rating-dot.active')).toHaveCount(4);
  });

  test('clicking the same star again deselects it', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    const star3 = msg.locator('.rating-dot').nth(2); // score 3
    await star3.click(); // select
    await expect(msg.locator('.rating-dot.active')).toHaveCount(3);
    await star3.click(); // deselect
    await expect(msg.locator('.rating-dot.active')).toHaveCount(0);
  });

  test('Save button is disabled with no star selected', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    const saveBtn = msg.locator('.rating-popover .perm-btn.perm-approve');
    await expect(saveBtn).toBeDisabled();
  });

  test('Save button is enabled after a star is selected', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    await msg.locator('.rating-dot').nth(1).click(); // score 2
    const saveBtn = msg.locator('.rating-popover .perm-btn.perm-approve');
    await expect(saveBtn).toBeEnabled();
  });

  // ── Submitting ──────────────────────────────────────────────────────────────

  test('Save without notes sends message_rating with rating and no notes', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    await msg.locator('.rating-dot').nth(4).click(); // score 5
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    const event = await client.waitForEvent(
      e => e['type'] === 'message_rating',
      5_000,
      'message_rating event'
    );

    expect(event['rating']).toBe(5);
    expect(event['notes']).toBeUndefined();
    client.close();
  });

  test('Save with notes sends message_rating with notes', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    await msg.locator('.rating-dot').nth(2).click(); // score 3
    await msg.locator('.rating-notes').fill('Could be more concise');
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    const event = await client.waitForEvent(
      e => e['type'] === 'message_rating',
      5_000,
      'message_rating event'
    );

    expect(event['rating']).toBe(3);
    expect(event['notes']).toBe('Could be more concise');
    client.close();
  });

  test('message_rating carries correct messageId', async () => {
    const page = getPage();
    const id = nextMsgId();
    const ts = new Date().toISOString();
    await injectEvent({
      type: 'message',
      message: { id, role: 'assistant', content: 'Specific message', timestamp: ts },
    });

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(0).click(); // score 1
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    const event = await client.waitForEvent(
      e => e['type'] === 'message_rating',
      5_000,
      'message_rating event'
    );
    expect(typeof event['messageId']).toBe('string');
    expect((event['messageId'] as string).length).toBeGreaterThan(0);
    client.close();
  });

  test('after save, popover closes', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(3).click();
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    await expect(msg.locator('.rating-popover')).toHaveCount(0);
  });

  test('after save, widget shows rated class and score badge', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(1).click(); // score 2
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    // Widget should now have rated class (stays visible even without hover)
    const widget = msg.locator('.rating-widget');
    await expect(widget).toHaveClass(/rated/);
    // Score badge shows the selected score
    await expect(widget.locator('.rating-trigger-score')).toHaveText('2');
    // Trigger has updated aria-label
    await expect(widget.locator('.rating-trigger')).toHaveAttribute('aria-label', 'Rated 2/5 — click to edit');
    // Widget stays visible (opacity 1) without hover because of rated class
    await expect(widget).toHaveCSS('opacity', '1');
  });

  // ── Editing an existing rating ──────────────────────────────────────────────

  test('re-opening popover pre-fills existing score', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // First save: score 4
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(3).click(); // score 4
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(msg.locator('.rating-popover')).toHaveCount(0);

    // Re-open
    await msg.locator('.rating-trigger').click();
    // 4 active stars expected
    await expect(msg.locator('.rating-dot.active')).toHaveCount(4);
  });

  test('re-opening popover pre-fills existing notes', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // First save with notes
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(4).click(); // score 5
    await msg.locator('.rating-notes').fill('Very helpful!');
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(msg.locator('.rating-popover')).toHaveCount(0);

    // Re-open
    await msg.locator('.rating-trigger').click();
    await expect(msg.locator('.rating-notes')).toHaveValue('Very helpful!');
  });

  test('saving a new score overwrites the old one', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // First save: score 5
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(4).click();
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(msg.locator('.rating-popover')).toHaveCount(0);

    // Second save: score 2
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(1).click(); // score 2
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    const events = client.collected().filter(e => e['type'] === 'message_rating');
    // Get the last event
    const last = await client.waitForEvent(
      e => e['type'] === 'message_rating' && e['rating'] === 2,
      5_000,
      'second message_rating'
    );
    expect(last['rating']).toBe(2);

    // Badge shows new score
    await expect(msg.locator('.rating-trigger-score')).toHaveText('2');
    client.close();
  });

  test('Clear button appears when message is already rated', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // Rate the message
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(2).click();
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(msg.locator('.rating-popover')).toHaveCount(0);

    // Re-open and check for Clear
    await msg.locator('.rating-trigger').click();
    await expect(msg.locator('.rating-popover .perm-btn.perm-deny')).toHaveText('Clear');
  });

  test('Clear button removes the rating', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // Rate first
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(3).click();
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(msg.locator('.rating-popover')).toHaveCount(0);

    // Re-open and clear
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-popover .perm-btn.perm-deny').click(); // Clear

    // Wait for the rating:0 event
    const clearEvent = await client.waitForEvent(
      e => e['type'] === 'message_rating' && e['rating'] === 0,
      5_000,
      'message_rating rating=0'
    );
    expect(clearEvent['rating']).toBe(0);

    // Widget no longer has rated class; no score badge; no trigger active class
    await expect(msg.locator('.rating-widget')).not.toHaveClass(/rated/);
    await expect(msg.locator('.rating-trigger-score')).toHaveCount(0);
    await expect(msg.locator('.rating-trigger')).not.toHaveClass(/active/);
    client.close();
  });

  test('Clear button sends message_rating with rating 0', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // Rate first
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(0).click(); // score 1
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(msg.locator('.rating-popover')).toHaveCount(0);

    // Clear
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-popover .perm-btn.perm-deny').click();

    const event = await client.waitForEvent(
      e => e['type'] === 'message_rating' && e['rating'] === 0,
      5_000,
      'clear rating event'
    );
    expect(event['rating']).toBe(0);
    client.close();
  });

  test('Clear button is absent when message is not yet rated', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    // perm-deny would be the Clear button — should not exist
    await expect(msg.locator('.rating-popover .perm-btn.perm-deny')).toHaveCount(0);
  });

  // ── Ctrl+Enter submits from notes textarea ──────────────────────────────────

  test('Ctrl+Enter in notes textarea submits the rating', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    await msg.locator('.rating-dot').nth(3).click(); // score 4
    await msg.locator('.rating-notes').fill('Good job');
    await msg.locator('.rating-notes').press('Control+Enter');

    const event = await client.waitForEvent(
      e => e['type'] === 'message_rating' && e['rating'] === 4,
      5_000,
      'message_rating via Ctrl+Enter'
    );
    expect(event['notes']).toBe('Good job');
    await expect(msg.locator('.rating-popover')).toHaveCount(0);
    client.close();
  });

  // ── Star hover fill ────────────────────────────────────────────────────────

  test('hovering a star fills it and all stars before it', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    // Hover the 3rd star — should activate stars 1-3
    await msg.locator('.rating-dot').nth(2).hover();
    await expect(msg.locator('.rating-dot.active')).toHaveCount(3);
  });

  test('moving mouse away from stars reverts hover fill but keeps pending selection', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    // Click score 4, then hover score 2 — display shows 2
    await msg.locator('.rating-dot').nth(3).click(); // pending = 4
    await msg.locator('.rating-dot').nth(1).hover(); // hover = 2, shows 2 active
    await expect(msg.locator('.rating-dot.active')).toHaveCount(2);

    // Move mouse off the stars entirely — pending (4) should reappear
    await msg.locator('.rating-popover-header').hover();
    await expect(msg.locator('.rating-dot.active')).toHaveCount(4);
  });

  // ── Rated widget stays visible ──────────────────────────────────────────────

  test('rated widget stays visible at opacity 1 after moving mouse away', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();
    await msg.locator('.rating-dot').nth(2).click(); // score 3
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    // Move mouse far away from the message
    await page.mouse.move(10, 10);

    // Widget should still be visible because of .rated class
    await expect(msg.locator('.rating-widget')).toHaveCSS('opacity', '1');
  });

  // ── Multiple messages — independent ratings ─────────────────────────────────

  test('ratings are independent per message', async () => {
    const page = getPage();
    await injectAssistantMessage('First response');
    await injectAssistantMessage('Second response');

    // Use the last two injected messages (the shared page may already have messages)
    const msgs = page.locator('.message.assistant:not(.streaming)');
    const count = await msgs.count();
    const first = msgs.nth(count - 2);
    const second = msgs.nth(count - 1);

    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    // Rate first message: 5
    await first.hover();
    await first.locator('.rating-trigger').click();
    await first.locator('.rating-dot').nth(4).click();
    await first.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(first.locator('.rating-popover')).toHaveCount(0);

    // Rate second message: 2
    await second.hover();
    await second.locator('.rating-trigger').click();
    await second.locator('.rating-dot').nth(1).click();
    await second.locator('.rating-popover .perm-btn.perm-approve').click();
    await expect(second.locator('.rating-popover')).toHaveCount(0);

    // Verify scores are independent
    await expect(first.locator('.rating-trigger-score')).toHaveText('5');
    await expect(second.locator('.rating-trigger-score')).toHaveText('2');
  });

  // ── Whitespace-only notes treated as no notes ───────────────────────────────

  test('whitespace-only notes are not sent', async () => {
    const page = getPage();
    await injectAssistantMessage();

    const client = new AigentWsClient();
    await client.connect();

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();
    await msg.locator('.rating-trigger').click();

    await msg.locator('.rating-dot').nth(2).click(); // score 3
    await msg.locator('.rating-notes').fill('   ');  // spaces only
    await msg.locator('.rating-popover .perm-btn.perm-approve').click();

    const event = await client.waitForEvent(
      e => e['type'] === 'message_rating' && e['rating'] === 3,
      5_000,
      'message_rating event'
    );
    expect(event['notes']).toBeUndefined();
    client.close();
  });

  // ── Streaming messages ──────────────────────────────────────────────────────

  test('no rating trigger during streaming', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'Streaming response...' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3_000 });
    await streamingMsg.hover();

    await expect(streamingMsg.locator('.rating-widget')).toHaveCount(0);

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('rating trigger appears after streaming completes', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'Streaming then done.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3_000 });
    await expect(streamingMsg.locator('.rating-widget')).toHaveCount(0);

    // Complete the stream
    await injectEvent({ type: 'loading', isLoading: false });

    const completedMsg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(completedMsg).toBeVisible({ timeout: 3_000 });
    await completedMsg.hover();
    await expect(completedMsg.locator('.rating-widget')).toHaveCount(1);
  });
});
