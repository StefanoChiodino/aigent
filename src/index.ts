import { config } from 'dotenv';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Agent } from './agent.js';

// Load .env files silently
const _origLog = console.log;
console.log = () => {}; // suppress dotenv v17 noise
config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve('/app', '.env') });
console.log = _origLog;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
    rl.once('close', () => {
      reject(new Error('Input closed'));
    });
  });
}

async function main(): Promise<void> {
  const model = process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';
  console.log(`🌸 aigent v0 — model: ${model}`);
  console.log('Type your message. /reset to clear history. Ctrl+C to exit.\n');

  let agent: Agent;
  try {
    agent = new Agent({ model });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error(`Fatal: ${error.message ?? 'Failed to initialize agent'}`);
    process.exit(1);
  }

  // Graceful shutdown
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
      input = await prompt('you > ');
    } catch {
      // readline closed (Ctrl+D)
      shutdown();
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // Built-in commands
    if (trimmed === '/reset') {
      agent.reset();
      console.log('🔄 Conversation reset.\n');
      continue;
    }

    if (trimmed === '/status') {
      console.log(`📊 Messages in conversation: ${agent.conversationLength}`);
      console.log(`   Model: ${model}\n`);
      continue;
    }

    if (trimmed === '/help') {
      console.log('Commands:');
      console.log('  /reset   — Clear conversation history');
      console.log('  /status  — Show conversation info');
      console.log('  /help    — Show this help');
      console.log('  Ctrl+C   — Exit\n');
      continue;
    }

    try {
      const startTime = Date.now();
      const response = await agent.chat(trimmed);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n🌸 ${response}`);
      console.log(`  (${elapsed}s)\n`);
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      if (error.status === 401) {
        console.error('❌ Authentication failed. Check your ANTHROPIC_API_KEY.\n');
      } else if (error.status === 429) {
        console.error('⏳ Rate limited. Wait a moment and try again.\n');
      } else {
        console.error(`❌ Error: ${error.message ?? 'unknown error'}\n`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
