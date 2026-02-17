import { createInterface } from 'node:readline';
import { Agent } from './agent.js';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

async function main(): Promise<void> {
  const model = process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';
  console.log(`🌸 aigent v0 — model: ${model}`);
  console.log('Type your message. Ctrl+C to exit.\n');

  const agent = new Agent({ model });

  while (true) {
    const input = await prompt('you > ');
    if (!input.trim()) continue;

    try {
      const response = await agent.chat(input);
      console.log(`\n🌸 ${response}\n`);
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error(`Error: ${error.message ?? 'unknown error'}\n`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
