#!/usr/bin/env node
/**
 * aigent CLI entry point.
 *
 * Dispatches subcommands:
 *   aigent init [workspace-path]   — first-run setup wizard
 *   aigent [gatekeeper flags...]   — start the agent (default)
 *
 * This file becomes the "aigent" bin in the installed npm package.
 * It is a thin dispatcher; all real logic lives in gatekeeper.tsx / init.ts.
 */

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === 'init') {
  const workspacePath = args[1]; // optional custom workspace path
  const { runInit } = await import('./init.js');
  await runInit(workspacePath);
  process.exit(0);
}

if (subcommand === '--help' || subcommand === '-h') {
  console.log(`aigent — AI agent platform

Usage:
  aigent init [workspace-path]   First-run setup: scaffold workspace, API key, TTS, extension
  aigent [options]               Start the agent

Options (passed to gatekeeper):
  --model <model>        Model to use (default: from AIGENT_MODEL env var)
  --thinking <level>     Thinking level: off, low, medium, high, max
  --headless             Web UI only, no terminal interface
  --provider <type>      LLM provider: anthropic (default) or openai
  --base-url <url>       Base URL for OpenAI-compatible endpoint
  --api-key <key>        API key for the LLM provider
  --workspace <path>     Workspace directory (overrides AIGENT_WORKSPACE / settings.json)
  --help, -h             Show this help

Examples:
  aigent init                   # First-time setup
  aigent                        # Start agent (web UI at http://localhost:3141)
  aigent --headless             # Web UI only, no TUI
  aigent --workspace ~/myws     # Use a custom workspace
`);
  process.exit(0);
}

// Handle --workspace flag before handing off to gatekeeper
// (gatekeeper doesn't know about --workspace yet, so we translate it to env var)
const workspaceIdx = args.indexOf('--workspace');
if (workspaceIdx !== -1 && args[workspaceIdx + 1]) {
  const wsPath = args[workspaceIdx + 1]!;
  process.env['AIGENT_WORKSPACE'] = wsPath;
  // Remove --workspace <path> from args so gatekeeper doesn't see unknown flags
  process.argv.splice(process.argv.indexOf('--workspace'), 2);
}

// Launch gatekeeper (the real agent process)
await import('./gatekeeper.js');
