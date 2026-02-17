/**
 * Entry point — starts the TUI client.
 *
 * The agent server runs as a separate process (managed by the supervisor).
 * This process is purely the frontend: it connects to the server over
 * a Unix socket, renders the TUI, and forwards user input.
 *
 * The TUI survives server restarts — it reconnects automatically.
 */

import { AgentClient } from './client.js';

const client = new AgentClient();

// Detect if we can run the full TUI or need fallback
const canUseTUI = Boolean(
  process.stdin.isTTY &&
  typeof process.stdin.setRawMode === 'function'
);

if (canUseTUI) {
  const { render } = await import('ink');
  const { App } = await import('./ui/App.js');
  render(<App client={client} />);
  client.connect();
} else {
  // Fallback: simple readline REPL
  const { startRepl } = await import('./repl.js');
  startRepl(client);
}
