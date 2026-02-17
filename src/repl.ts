import { createInterface } from 'node:readline';
import type { Agent } from './agent.js';

function prompt(rl: ReturnType<typeof createInterface>, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
    rl.once('close', () => {
      reject(new Error('Input closed'));
    });
  });
}

/**
 * Simple readline-based REPL for non-TTY environments (piped input, CI, etc.)
 */
export async function startRepl(agent: Agent, model: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`🌸 aigent v0 — model: ${model}`);
  console.log('  (fallback mode — no TUI support detected)');
  console.log('Type your message. /reset to clear history. Ctrl+C to exit.\n');

  const shutdown = (): void => {
    console.log('\n👋 Goodbye.');
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

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

    if (trimmed === '/reset') {
      agent.reset();
      console.log('🔄 Conversation reset.\n');
      continue;
    }

    if (trimmed === '/help') {
      console.log('Commands: /reset /status /help  Ctrl+C to exit\n');
      continue;
    }

    if (trimmed === '/status') {
      console.log(`📊 Model: ${model} | Messages: ${agent.conversationLength}\n`);
      continue;
    }

    try {
      const startTime = Date.now();
      const response = await agent.chat(trimmed, {
        onToolStart: (name, toolInput) => {
          console.log(`  ⚡ ${name}: ${toolInput}`);
        },
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n🌸 ${response}`);
      console.log(`  (${elapsed}s)\n`);
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      if (error.status === 401) {
        console.error('❌ Authentication failed. Check ANTHROPIC_API_KEY.\n');
      } else if (error.status === 429) {
        console.error('⏳ Rate limited.\n');
      } else {
        console.error(`❌ Error: ${error.message ?? 'unknown error'}\n`);
      }
    }
  }
}
