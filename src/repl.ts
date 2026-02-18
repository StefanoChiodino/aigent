import { createInterface } from 'node:readline';
import type { AgentClient } from './client.js';
import type { ServerState } from './protocol.js';

function prompt(rl: ReturnType<typeof createInterface>, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = (): void => { reject(new Error('Input closed')); };
    rl.once('close', onClose);
    rl.question(query, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

/**
 * Simple readline-based REPL for non-TTY environments (piped input, CI, etc.)
 * Connects to the agent server via the client.
 */
export function startRepl(client: AgentClient): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let model = '(connecting)';
  let ready = false;

  client.on('connected', (state: ServerState) => {
    model = state.model;
    ready = true;
    console.log(`aigent — model: ${model}`);
    console.log('  (fallback mode — no TUI support)');
    console.log('Type your message. /reset to clear. Ctrl+C to exit.\n');
  });

  client.on('text', (content: string) => {
    process.stdout.write(`\r\x1b[K${content}`);
  });

  client.on('message', (msg) => {
    if (msg.role === 'assistant') {
      console.log(`\nagent > ${msg.content}`);
      if (msg.elapsed) console.log(`  (${msg.elapsed.toFixed(1)}s)`);
      console.log();
    }
  });

  client.on('system', (content: string) => {
    console.log(`  ${content}`);
  });

  client.on('tool_start', (_name: string, _input: string, summary: string) => {
    console.log(`  > ${summary}`);
  });

  client.on('error', (message: string) => {
    console.error(`Error: ${message}\n`);
  });

  client.on('disconnected', () => {
    console.log('\n  (server disconnected, reconnecting...)');
    ready = false;
  });

  client.connect();

  const shutdown = (): void => {
    console.log('\nGoodbye.');
    client.disconnect();
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function loop(): Promise<void> {
    while (true) {
      let input: string;
      try {
        input = await prompt(rl, 'you > ');
      } catch {
        shutdown();
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (!ready) {
        console.log('  (not connected yet, waiting...)\n');
        continue;
      }

      client.sendMessage(trimmed);
    }
  }

  void loop();
}
