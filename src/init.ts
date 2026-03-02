#!/usr/bin/env node
/**
 * aigent init — first-run setup wizard.
 *
 * Creates config and workspace directories, copies starter config files,
 * prompts for an API key, and optionally sets up STT/TTS and the Chrome extension.
 *
 * Usage:
 *   aigent init                  — uses XDG default workspace
 *   aigent init ~/my-workspace   — custom workspace path
 */

import { createInterface } from 'node:readline';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { getConfigDir, getEnvFile, getSettingsFile, getDefaultWorkspace } from './xdg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function print(msg: string): void { process.stdout.write(msg + '\n'); }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function commandExists(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

export async function runInit(workspaceArg?: string): Promise<void> {
  print('');
  print(bold('aigent — setup wizard'));
  print(dim('─────────────────────────────────────────'));
  print('');

  const configDir = getConfigDir();
  const workspaceDir = workspaceArg ? resolve(workspaceArg) : getDefaultWorkspace();

  // ── 1. Create directories ───────────────────────────────────────────────────
  print(`${bold('1.')} Creating directories`);

  const dirs = [
    configDir,
    workspaceDir,
    join(workspaceDir, 'config'),
    join(workspaceDir, 'memory'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    print(`   ${green('✓')} ${dir}`);
  }
  print('');

  // ── 2. Copy workspace template files ───────────────────────────────────────
  print(`${bold('2.')} Installing workspace config templates`);

  // Templates are next to this file when running from source (src/),
  // or in dist/../src/workspace-templates/ after compilation.
  const templateCandidates = [
    join(__dirname, 'workspace-templates'),           // src/ (tsx / dev)
    join(__dirname, '..', 'src', 'workspace-templates'), // dist/ (compiled)
  ];
  const templateDir = templateCandidates.find(existsSync);

  if (templateDir) {
    const configTemplateDir = join(templateDir, 'config');
    if (existsSync(configTemplateDir)) {
      for (const file of readdirSync(configTemplateDir)) {
        const dest = join(workspaceDir, 'config', file);
        if (!existsSync(dest)) {
          copyFileSync(join(configTemplateDir, file), dest);
          print(`   ${green('✓')} config/${file}`);
        } else {
          print(`   ${dim('·')} config/${file} ${dim('(already exists, skipping)')}`);
        }
      }
    }
    const mcpExample = join(templateDir, 'mcp.json.example');
    if (existsSync(mcpExample)) {
      const dest = join(workspaceDir, 'mcp.json.example');
      if (!existsSync(dest)) {
        copyFileSync(mcpExample, dest);
        print(`   ${green('✓')} mcp.json.example`);
      }
    }
  } else {
    print(`   ${yellow('⚠')} Template directory not found — workspace config files skipped`);
  }
  print('');

  // ── 3. API key ──────────────────────────────────────────────────────────────
  print(`${bold('3.')} API key configuration`);

  const envFile = getEnvFile();
  let existingKey = '';

  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf-8');
    const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match) existingKey = match[1]!.trim();
  }

  // Also check if key is already in process.env (e.g. shell environment)
  const envKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'];

  if (existingKey) {
    print(`   ${green('✓')} ANTHROPIC_API_KEY already set in ${envFile}`);
  } else if (envKey) {
    print(`   ${dim('·')} API key found in shell environment — not writing to file`);
    print(`   ${dim('  Tip: run `aigent init` to save it permanently')}`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    print(`   Enter your Anthropic API key (or press Enter to skip):`);
    print(`   ${dim('Get one at: https://console.anthropic.com/')}`);
    const key = (await ask(rl, '   sk-ant-... ')).trim();
    rl.close();

    if (key) {
      const existing = existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '';
      const updated = existing.includes('ANTHROPIC_API_KEY=')
        ? existing.replace(/^ANTHROPIC_API_KEY=.*/m, `ANTHROPIC_API_KEY=${key}`)
        : `${existing}\nANTHROPIC_API_KEY=${key}\n`.trimStart();
      writeFileSync(envFile, updated, { mode: 0o600 }); // user-only read
      print(`   ${green('✓')} Saved to ${envFile}`);
    } else {
      print(`   ${yellow('⚠')} Skipped — set ANTHROPIC_API_KEY in ${envFile} before running aigent`);
    }
  }
  print('');

  // ── 4. Settings file ────────────────────────────────────────────────────────
  print(`${bold('4.')} Settings`);
  const settingsFile = getSettingsFile();
  if (!existsSync(settingsFile)) {
    writeFileSync(settingsFile, JSON.stringify({
      AIGENT_WORKSPACE: workspaceDir,
    }, null, 2) + '\n');
    print(`   ${green('✓')} Created ${settingsFile}`);
  } else {
    // Ensure AIGENT_WORKSPACE is set to this workspace if not already present
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
      if (!settings['AIGENT_WORKSPACE']) {
        settings['AIGENT_WORKSPACE'] = workspaceDir;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
        print(`   ${green('✓')} Updated ${settingsFile} — set AIGENT_WORKSPACE`);
      } else {
        print(`   ${dim('·')} ${settingsFile} ${dim('(already exists, keeping as-is)')}`);
      }
    } catch {
      print(`   ${yellow('⚠')} Could not parse existing settings.json — leaving unchanged`);
    }
  }
  print('');

  // ── 5. TTS setup ────────────────────────────────────────────────────────────
  print(`${bold('5.')} TTS (text-to-speech) — edge-tts`);

  const installDir = resolve(__dirname, '..');
  const ttsPythonCandidates = [
    join(__dirname, '..', 'tts'),        // dev (src/../tts)
    join(__dirname, '..', '..', 'tts'),  // dist/../tts
  ];
  const ttsDir = ttsPythonCandidates.find((d) => existsSync(join(d, 'requirements.txt')));

  if (!ttsDir) {
    print(`   ${yellow('⚠')} TTS source not found in package — skipping`);
  } else if (!commandExists('python3')) {
    print(`   ${yellow('⚠')} python3 not found — skipping (TTS is optional)`);
  } else {
    const venv = join(ttsDir, '.venv');
    if (existsSync(venv)) {
      print(`   ${dim('·')} TTS venv already exists — skipping`);
    } else {
      print(`   Setting up TTS venv...`);
      const r1 = spawnSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
      if (r1.status !== 0) {
        print(`   ${red('✗')} Failed to create TTS venv`);
      } else {
        const pip = join(venv, 'bin', 'pip');
        const req = join(ttsDir, 'requirements.txt');
        const r2 = spawnSync(pip, ['install', '-r', req], { stdio: 'inherit' });
        if (r2.status !== 0) {
          print(`   ${red('✗')} Failed to install TTS dependencies`);
        } else {
          print(`   ${green('✓')} TTS ready`);
        }
      }
    }
  }
  print('');

  // ── 6. STT setup ────────────────────────────────────────────────────────────
  print(`${bold('6.')} STT (speech-to-text) — sherpa-onnx Zipformer`);
  print(`   ${dim('No Python or GPU required — runs on CPU via native Node.js addon')}`);

  const sttCandidates = [
    join(__dirname, '..', 'stt'),
    join(__dirname, '..', '..', 'stt'),
  ];
  const sttDir = sttCandidates.find((d) => existsSync(join(d, 'package.json')));

  if (!sttDir) {
    print(`   ${yellow('⚠')} STT source not found in package — skipping`);
  } else {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await ask(rl2, `   Install STT? Downloads ~400 MB model [y/N]: `)).trim().toLowerCase();
    rl2.close();
    if (answer === 'y' || answer === 'yes') {
      const nodeModules = join(sttDir, 'node_modules');
      if (existsSync(nodeModules)) {
        print(`   ${dim('·')} STT dependencies already installed`);
      } else {
        const r1 = spawnSync('npm', ['install'], { cwd: sttDir, stdio: 'inherit' });
        if (r1.status !== 0) {
          print(`   ${red('✗')} Failed to install STT dependencies`);
        } else {
          print(`   ${green('✓')} STT dependencies installed`);
        }
      }
      // Download model if not present
      const downloadScript = join(sttDir, 'download-model.sh');
      if (existsSync(downloadScript)) {
        const r2 = spawnSync('bash', [downloadScript], { cwd: sttDir, stdio: 'inherit' });
        if (r2.status !== 0) {
          print(`   ${red('✗')} Failed to download STT model`);
        } else {
          print(`   ${green('✓')} STT ready`);
        }
      }
    } else {
      print(`   ${dim('·')} Skipped — run \`aigent init\` again or \`make stt-setup\` from the repo to install later`);
    }
  }
  print('');

  // ── 7. Chrome extension ─────────────────────────────────────────────────────
  print(`${bold('7.')} Chrome extension`);

  const extCandidates = [
    join(__dirname, '..', 'aigent-extension'),
    join(__dirname, '..', '..', 'aigent-extension'),
  ];
  const extDir = extCandidates.find((d) => existsSync(join(d, 'build.mjs')));

  if (!extDir) {
    print(`   ${yellow('⚠')} Extension source not found in package — skipping`);
  } else {
    const extDist = join(extDir, 'dist');
    const needsBuild = !existsSync(join(extDist, 'background'));

    if (needsBuild) {
      print(`   Building extension...`);
      // Extension needs its own node_modules (esbuild)
      const hasNodeModules = existsSync(join(extDir, 'node_modules'));
      if (!hasNodeModules) {
        print(`   Installing extension dependencies...`);
        const r0 = spawnSync('npm', ['install', '--prefix', extDir], { stdio: 'inherit' });
        if (r0.status !== 0) {
          print(`   ${red('✗')} npm install failed for extension`);
        }
      }
      const r = spawnSync('node', ['build.mjs'], { cwd: extDir, stdio: 'inherit' });
      if (r.status !== 0) {
        print(`   ${red('✗')} Extension build failed`);
      } else {
        print(`   ${green('✓')} Extension built`);
      }
    } else {
      print(`   ${green('✓')} Extension already built`);
    }

    if (existsSync(join(extDist, 'background'))) {
      print('');
      print(`   ${bold('To install the Chrome extension:')}`);
      print(`   1. Open ${bold('chrome://extensions')} in Chrome`);
      print(`   2. Enable ${bold('Developer mode')} (top-right toggle)`);
      print(`   3. Click ${bold('Load unpacked')}`);
      print(`   4. Select: ${bold(extDist)}`);
    }
  }
  print('');

  // ── Done ────────────────────────────────────────────────────────────────────
  print(dim('─────────────────────────────────────────'));
  print(green(bold('✓ Setup complete!')));
  print('');
  print(`  Workspace:  ${bold(workspaceDir)}`);
  print(`  Config:     ${bold(configDir)}`);
  print('');
  print(`  Start aigent:   ${bold('aigent')}`);
  print(`  Then open:      ${bold('http://localhost:3141')}`);
  print('');

  void installDir; // suppress unused-var warning
}
