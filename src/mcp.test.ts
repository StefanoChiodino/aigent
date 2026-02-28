import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCPManager } from './mcp.js';

describe('MCPManager', () => {
  it('starts with zero servers and tools', () => {
    const manager = new MCPManager();
    assert.equal(manager.stats.servers, 0);
    assert.equal(manager.stats.tools, 0);
    assert.deepEqual(manager.getTools(), []);
  });

  it('isMCPTool returns false for unknown tools', () => {
    const manager = new MCPManager();
    assert.equal(manager.isMCPTool('exec'), false);
    assert.equal(manager.isMCPTool('mcp_foo_bar'), false);
  });

  it('callTool returns error for unknown tool', async () => {
    const manager = new MCPManager();
    const result = await manager.callTool('mcp_unknown_tool', {});
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('unknown MCP tool'));
  });

  it('shutdown clears all state', () => {
    const manager = new MCPManager();
    manager.shutdown();
    assert.equal(manager.stats.servers, 0);
    assert.equal(manager.stats.tools, 0);
  });
});

describe('MCPManager.initialize', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('does nothing when config file does not exist', async () => {
    const manager = new MCPManager();
    await manager.initialize(join(tmpDir, 'nonexistent.json'));
    assert.equal(manager.stats.servers, 0);
  });

  it('handles malformed JSON gracefully', async () => {
    writeFileSync(join(tmpDir, 'mcp.json'), 'not json');
    const manager = new MCPManager();
    await manager.initialize(join(tmpDir, 'mcp.json'));
    assert.equal(manager.stats.servers, 0);
  });

  it('handles empty servers object', async () => {
    writeFileSync(join(tmpDir, 'mcp.json'), JSON.stringify({ servers: {} }));
    const manager = new MCPManager();
    await manager.initialize(join(tmpDir, 'mcp.json'));
    assert.equal(manager.stats.servers, 0);
  });

  it('handles config without servers key', async () => {
    writeFileSync(join(tmpDir, 'mcp.json'), JSON.stringify({ other: 'stuff' }));
    const manager = new MCPManager();
    await manager.initialize(join(tmpDir, 'mcp.json'));
    assert.equal(manager.stats.servers, 0);
  });

  it('callTool returns error for server not running', async () => {
    // Simulate a tool mapped to a server that was removed (e.g., after crash)
    const manager = new MCPManager();
    const result = await manager.callTool('mcp_ghost_tool', {});
    assert.ok(result.includes('Error'));
  });
});
