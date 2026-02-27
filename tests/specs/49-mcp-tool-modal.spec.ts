/**
 * 49 — MCP tool permission modal (injected, no LLM)
 *
 * Injects fake mcp_tool_request events via POST /test/inject.
 * Verifies the modal shows with correct icon, title, tool info, and buttons.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast MCP Tool Permission Modal', () => {
  const getPage = useSharedPage();

  test('mcp_tool_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp1', server: 'github', tool: 'list_repos', params: '{}' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows server/tool in the detail area', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp2', server: 'slack', tool: 'send_message', params: '{"channel": "#general"}' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('slack/send_message');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal title is "MCP Tool"', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp3', server: 'github', tool: 'create_issue', params: '{}' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('MCP Tool');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal icon shows plug emoji', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp4', server: 'github', tool: 'get_pr', params: '{}' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('🔌');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows params in body', async () => {
    const page = getPage();
    const params = '{"repo": "aigent", "number": 42}';
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp5', server: 'github', tool: 'get_pr', params });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-body')).toContainText('aigent');
    await page.locator('#perm-deny-btn').click();
  });

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp6', server: 'test', tool: 'action', params: '{}' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'mcp7', server: 'test', tool: 'action', params: '{}' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('file_access and mcp_tool requests queue correctly', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'q_fa1', path: '/etc/hosts', operation: 'read', reason: 'test' });
    await injectEvent({ type: 'mcp_tool_request', id: 'q_mcp1', server: 'github', tool: 'list', params: '{}' });

    // First (file_access) visible
    await expect(page.locator('#perm-card-icon')).toHaveText('📄', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();

    // Second (mcp_tool) shows immediately
    await expect(page.locator('#perm-card-icon')).toHaveText('🔌', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });
});
