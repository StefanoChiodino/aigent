import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Agent } from './agent.js';

// Load .env files silently
const _origLog = console.log;
console.log = () => {};
config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve('/app', '.env') });
console.log = _origLog;

const model = process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';

let agent: Agent;
try {
  agent = new Agent({ model });
} catch (err: unknown) {
  const error = err as { message?: string };
  console.error(`Fatal: ${error.message ?? 'Failed to initialize agent'}`);
  process.exit(1);
}

// Detect if we can run the full TUI or need fallback
const canUseTUI = Boolean(
  process.stdin.isTTY &&
  typeof process.stdin.setRawMode === 'function'
);

if (canUseTUI) {
  // Dynamic import to avoid loading ink/react when not needed
  const { render } = await import('ink');
  const { App } = await import('./ui/App.js');
  render(<App agent={agent} model={model} />);
} else {
  // Fallback: simple readline REPL for non-TTY environments
  const { startRepl } = await import('./repl.js');
  startRepl(agent, model);
}
