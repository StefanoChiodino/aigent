/**
 * Slash command registry — each command is a small handler object.
 *
 * Extracted from server.ts to make commands independently testable
 * and easy to add. server.ts provides the CommandContext at runtime.
 */

import type { Agent, ThinkingLevel } from './agent.js';
import type { UserContent, ProviderMessage, Provider } from './provider.js';
import type { ServerEvent, TokenUsage, DisplayAttachment } from './protocol.js';
import type { TaskQueue } from './tasks.js';
import { distillToMemory } from './compact.js';
import { clearContextCache } from './workspace.js';
import {
  listProfiles, getProfilePath, listSessions, saveSession,
  loadSession, generateSessionId, clearAutoSave,
} from './profiles.js';
import { formatLifetimeUsage } from './usage-tracking.js';
import { readImageBase64 } from './image-support.js';
import { resolveModelAlias } from './server.js';
import { writeSettings } from './settings-file.js';

// ---------------------------------------------------------------------------
// Context interface — provided by server.ts
// ---------------------------------------------------------------------------

export interface CommandContext {
  agent: Agent;
  taskQueue: TaskQueue;
  provider: Provider;

  // State (read/write)
  get messages(): import('./protocol.js').DisplayMessage[];
  set messages(v: import('./protocol.js').DisplayMessage[]);
  get usage(): TokenUsage;
  set usage(v: TokenUsage);
  get currentThinking(): ThinkingLevel;
  set currentThinking(v: ThinkingLevel);
  get savedEffortLevel(): ThinkingLevel;
  set savedEffortLevel(v: ThinkingLevel);
  get currentShort(): boolean;
  set currentShort(v: boolean);
  get currentProfile(): string;
  set currentProfile(v: string);
  get currentSessionId(): string;
  set currentSessionId(v: string);
  get model(): string;
  set model(v: string);
  get isLoading(): boolean;
  get workspacePath(): string;
  get availableModels(): string[];
  getContextWindow(modelId: string): number;
  get toolsUsed(): string[];
  get sessionStartedAt(): string;
  get ratings(): Record<string, number>;
  get frictionSignals(): string[];
  resetSessionTracking(): void;

  // Helpers
  addSystemMessage(content: string): void;
  broadcast(event: ServerEvent): void;
  doAutoSave(): void;
  buildExtraSystemPrompt(): string;
  requestRestart(): void;
  processAgentTurn(
    content: string | UserContent,
    opts?: { displayText?: string; displayAttachments?: DisplayAttachment[] },
  ): Promise<void>;
}

const VALID_EFFORT_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high', 'max'];

// ---------------------------------------------------------------------------
// State-mutation functions — used by both structured messages and slash commands
// ---------------------------------------------------------------------------

/** Toggle reasoning on or off. */
export function setThinking(enabled: boolean, ctx: CommandContext): void {
  if (enabled) {
    if (ctx.currentThinking === 'off') {
      ctx.agent.thinkingLevel = ctx.savedEffortLevel;
      ctx.currentThinking = ctx.savedEffortLevel;
    }
  } else {
    if (ctx.currentThinking !== 'off') {
      ctx.savedEffortLevel = ctx.currentThinking;
    }
    ctx.agent.thinkingLevel = 'off';
    ctx.currentThinking = 'off';
  }
  ctx.broadcast({ type: 'state', thinking: ctx.currentThinking });
  ctx.doAutoSave();
}

/** Set effort level (low/medium/high/max). Returns false if invalid. */
export function setEffort(level: ThinkingLevel, ctx: CommandContext): boolean {
  if (!VALID_EFFORT_LEVELS.includes(level)) return false;
  ctx.agent.thinkingLevel = level;
  ctx.currentThinking = level;
  ctx.broadcast({ type: 'state', thinking: ctx.currentThinking });
  ctx.doAutoSave();
  return true;
}

/** Toggle short/voice mode. */
export function setShort(enabled: boolean, ctx: CommandContext): void {
  ctx.currentShort = enabled;
  ctx.agent.setExtraSystemPrompt(ctx.buildExtraSystemPrompt());
  ctx.broadcast({ type: 'state', short: enabled });
  ctx.doAutoSave();
}

/** Switch the active model. Returns result with ok status. */
export function setModel(model: string, ctx: CommandContext): { ok: boolean; message?: string } {
  // Resolve tier aliases (flash/pro/ultra/cheap/standard/expensive) to actual model IDs
  // before validating against availableModels
  const resolvedModel = resolveModelAlias(model);

  const finalModel = resolvedModel !== model ? resolvedModel : model;

  if (finalModel === ctx.model) {
    return { ok: true, message: `Already using: ${ctx.model}` };
  }

  // If we have a model list and the model isn't in it, still allow — the list may be
  // stale or from a custom/local endpoint that reports different IDs.

  ctx.model = finalModel;
  ctx.agent.currentModel = finalModel;
  ctx.broadcast({ type: 'state', model: finalModel, contextWindow: ctx.getContextWindow(finalModel) });
  ctx.doAutoSave();
  // Persist so the model survives server restarts
  void writeSettings('setModel', (s) => ({ ...s, AIGENT_MODEL: finalModel }));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

interface CommandDef {
  /** Exact match or prefix to test against trimmed input. */
  match: string | ((input: string) => boolean);
  /** Execute the command. Return true if handled. */
  execute: (input: string, ctx: CommandContext) => boolean;
}

const commands: CommandDef[] = [
  // --- /reset ---
  {
    match: '/reset',
    execute: (_input, ctx) => {
      // Auto-log episode before reset (fire-and-forget)
      const userMsgCount = ctx.messages.filter(m => m.role === 'user').length;
      if (userMsgCount >= 2) {
        void import('./episodes.js').then(({ autoLogEpisode, wasSessionLogged }) => {
          if (!wasSessionLogged(ctx.currentSessionId)) {
            autoLogEpisode({
              messages: ctx.messages,
              usage: ctx.usage,
              model: ctx.model,
              profile: ctx.currentProfile,
              sessionId: ctx.currentSessionId,
              workspacePath: ctx.workspacePath,
              toolsUsed: ctx.toolsUsed,
              sessionStartedAt: ctx.sessionStartedAt,
              source: 'auto-reset',
              ratings: ctx.ratings,
              frictionSignals: ctx.frictionSignals,
            });
          }
        }).catch(() => {});
      }

      const messagesToDistill = ctx.agent.getMessages();
      if (messagesToDistill.length >= 4) {
        ctx.addSystemMessage('Distilling session to memory...');
        void distillToMemory(ctx.agent.underlyingProvider, ctx.agent.currentModel, messagesToDistill, ctx.workspacePath)
          .then(async () => {
            ctx.addSystemMessage('Memory updated.');
            try {
              const { runReflection } = await import('./reflection.js');
              await runReflection(ctx.agent.underlyingProvider, ctx.workspacePath);
            } catch { /* non-critical */ }
          })
          .catch(() => {});
      }
      ctx.agent.reset();
      ctx.messages = [];
      ctx.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      ctx.resetSessionTracking();
      clearAutoSave(ctx.workspacePath);
      ctx.broadcast({ type: 'reset' });
      ctx.addSystemMessage('Conversation reset.');
      ctx.broadcast({ type: 'usage', usage: ctx.usage });
      return true;
    },
  },

  // --- /refresh ---
  {
    match: '/refresh',
    execute: (_input, ctx) => {
      clearContextCache();
      ctx.agent.reloadSystemPrompt();
      ctx.addSystemMessage('Workspace files reloaded.');
      return true;
    },
  },

  // --- /restart ---
  {
    match: '/restart',
    execute: (_input, ctx) => {
      ctx.addSystemMessage('Restarting server...');
      setTimeout(() => ctx.requestRestart(), 200);
      return true;
    },
  },

  // --- /reload ---
  // Note: /reload is intercepted by the gatekeeper (typecheck → build → restart).
  // This entry is a fallback for environments where the gatekeeper is not running.
  {
    match: '/reload',
    execute: (_input, ctx) => {
      ctx.addSystemMessage('Reloading server (typecheck → build → restart)...\nNote: /reload is normally handled by the gatekeeper.');
      setTimeout(() => ctx.requestRestart(), 200);
      return true;
    },
  },

  // --- /reasoning ---
  {
    match: (input) => input === '/reasoning' || input === '/reasoning on' || input === '/reasoning off',
    execute: (input, ctx) => {
      if (input === '/reasoning') {
        const isOn = ctx.currentThinking !== 'off';
        ctx.addSystemMessage(`Reasoning: ${isOn ? 'on' : 'off'}\nUsage: /reasoning on | /reasoning off`);
        return true;
      }
      if (input === '/reasoning on') {
        setThinking(true, ctx);
        ctx.addSystemMessage(`Reasoning: on (${ctx.currentThinking})`);
        return true;
      }
      if (input === '/reasoning off') {
        setThinking(false, ctx);
        ctx.addSystemMessage('Reasoning: off');
        return true;
      }
      return false;
    },
  },

  // --- /effort ---
  {
    match: (input) => input === '/effort' || input.startsWith('/effort '),
    execute: (input, ctx) => {
      if (input === '/effort') {
        ctx.addSystemMessage(
          `Effort: ${ctx.currentThinking === 'off' ? '(reasoning off)' : ctx.currentThinking}\n` +
          `Levels: ${VALID_EFFORT_LEVELS.join(', ')}\nUsage: /effort <level>`,
        );
        return true;
      }
      const level = input.split(' ')[1] as ThinkingLevel;
      if (setEffort(level, ctx)) {
        ctx.addSystemMessage(`Effort: ${level}`);
      } else {
        ctx.addSystemMessage(`Invalid effort. Options: ${VALID_EFFORT_LEVELS.join(', ')}`);
      }
      return true;
    },
  },

  // --- /short ---
  {
    match: (input) => input === '/short' || input === '/short on' || input === '/short off',
    execute: (input, ctx) => {
      if (input === '/short') {
        ctx.addSystemMessage(`Short mode: ${ctx.currentShort ? 'on' : 'off'}\nUsage: /short on | /short off`);
        return true;
      }
      const enabled = input === '/short on';
      setShort(enabled, ctx);
      ctx.addSystemMessage(`Short mode: ${enabled ? 'on' : 'off'}`);
      return true;
    },
  },

  // --- /profiles, /profile ---
  {
    match: (input) => input === '/profiles' || input.startsWith('/profile'),
    execute: (input, ctx) => {
      if (input === '/profiles' || input === '/profile list') {
        const profiles = listProfiles(ctx.workspacePath);
        if (profiles.length === 0) {
          ctx.addSystemMessage(`No profiles yet. Current: ${ctx.currentProfile}\nCreate one: /profile create <name>`);
        } else {
          const list = profiles.map((p) => `  ${p.name === ctx.currentProfile ? '>' : ' '} ${p.name}`).join('\n');
          ctx.addSystemMessage(`Profiles:\n${list}`);
        }
        return true;
      }
      if (input.startsWith('/profile create ')) {
        const name = input.slice('/profile create '.length).trim();
        if (!name || name.includes('/') || name.includes('..')) {
          ctx.addSystemMessage('Invalid profile name.');
          return true;
        }
        getProfilePath(ctx.workspacePath, name);
        ctx.addSystemMessage(`Profile "${name}" created. Switch to it: /profile ${name}`);
        return true;
      }
      if (input.startsWith('/profile ') && !input.startsWith('/profile list') && !input.startsWith('/profile create')) {
        const name = input.slice('/profile '.length).trim();
        const profileDir = getProfilePath(ctx.workspacePath, name);
        ctx.agent.reset();
        ctx.agent.reloadWorkspace(profileDir);
        ctx.currentProfile = name;
        ctx.currentSessionId = generateSessionId();
        ctx.messages = [];
        ctx.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        ctx.addSystemMessage(`Switched to profile: ${name}`);
        ctx.broadcast({ type: 'state', profile: ctx.currentProfile, sessionId: ctx.currentSessionId });
        ctx.broadcast({ type: 'usage', usage: ctx.usage });
        return true;
      }
      return false;
    },
  },

  // --- /save ---
  {
    match: '/save',
    execute: (_input, ctx) => {
      saveSession(ctx.workspacePath, ctx.currentProfile, ctx.currentSessionId, ctx.agent.getMessages());
      ctx.addSystemMessage(`Session saved: ${ctx.currentSessionId}`);
      return true;
    },
  },

  // --- /sessions ---
  {
    match: '/sessions',
    execute: (_input, ctx) => {
      const sessions = listSessions(ctx.workspacePath, ctx.currentProfile);
      if (sessions.length === 0) {
        ctx.addSystemMessage('No saved sessions. Use /save to save current session.');
      } else {
        const list = sessions.map((s) =>
          `  ${s.id === ctx.currentSessionId ? '>' : ' '} ${s.id} (${s.messageCount} msgs, ${s.lastActiveAt.slice(0, 10)})`,
        ).join('\n');
        ctx.addSystemMessage(`Sessions (${ctx.currentProfile}):\n${list}`);
      }
      return true;
    },
  },

  // --- /load ---
  {
    match: (input) => input.startsWith('/load '),
    execute: (input, ctx) => {
      const sessionId = input.slice('/load '.length).trim();
      const data = loadSession(ctx.workspacePath, ctx.currentProfile, sessionId);
      if (!data) {
        ctx.addSystemMessage(`Session not found: ${sessionId}`);
        return true;
      }
      ctx.agent.setMessages(data.messages as ProviderMessage[]);
      ctx.currentSessionId = sessionId;
      ctx.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      ctx.addSystemMessage(`Loaded session: ${sessionId} (${data.messages.length} messages)`);
      ctx.broadcast({ type: 'state', sessionId: ctx.currentSessionId });
      ctx.broadcast({ type: 'usage', usage: ctx.usage });
      return true;
    },
  },

  // --- /image ---
  {
    match: (input) => input.startsWith('/image'),
    execute: (input, ctx) => {
      if (input === '/image' || input === '/image ') {
        ctx.addSystemMessage('Usage: /image <path> [message]\nExample: /image /tmp/screenshot.png What is this?');
        return true;
      }
      const rest = input.slice('/image '.length).trim();
      if (!rest) {
        ctx.addSystemMessage('Usage: /image <path> [message]\nExample: /image /tmp/screenshot.png What is this?');
        return true;
      }
      const spaceIdx = rest.indexOf(' ');
      const imgPath = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
      const imgText = spaceIdx > 0 ? rest.slice(spaceIdx + 1).trim() : 'Describe this image.';

      const img = readImageBase64(imgPath);
      if (!img) {
        ctx.addSystemMessage(`Cannot read image: ${imgPath}\nSupported formats: PNG, JPG, GIF, WebP`);
        return true;
      }

      const userContent: UserContent = [
        { type: 'image', mediaType: img.mediaType, data: img.data },
        { type: 'text', text: imgText },
      ];

      if (ctx.isLoading) {
        ctx.addSystemMessage('Cannot send image while processing. Wait for the current request to finish.');
        return true;
      }
      void ctx.processAgentTurn(userContent, { displayText: `[image: ${imgPath}] ${imgText}` });
      return true;
    },
  },

  // --- /compact ---
  {
    match: '/compact',
    execute: (_input, ctx) => {
      if (ctx.isLoading) {
        ctx.addSystemMessage('Cannot compact while loading.');
        return true;
      }
      ctx.addSystemMessage('Compacting conversation...');
      void (async () => {
        try {
          const result = await ctx.agent.forceCompact({
            onCompact: (summary: string) => {
              ctx.addSystemMessage(`Context compacted: ${summary.slice(0, 200)}...`);
            },
          });
          ctx.addSystemMessage(result);
          ctx.doAutoSave();
        } catch (err: unknown) {
          const e = err as { message?: string };
          ctx.addSystemMessage(`Compaction failed: ${e.message ?? 'unknown error'}`);
        }
      })();
      return true;
    },
  },

  // --- /usage ---
  {
    match: '/usage',
    execute: (_input, ctx) => {
      ctx.addSystemMessage(formatLifetimeUsage(ctx.workspacePath, ctx.usage));
      return true;
    },
  },

  // --- /context ---
  {
    match: '/context',
    execute: (_input, ctx) => {
      ctx.broadcast({ type: 'context_breakdown', breakdown: ctx.agent.getContextBreakdown() });
      return true;
    },
  },

  // --- /tasks ---
  {
    match: '/tasks',
    execute: (_input, ctx) => {
      const allTasks = ctx.taskQueue.getInfos();
      if (allTasks.length === 0) {
        ctx.addSystemMessage('No background tasks.');
        return true;
      }
      const running = allTasks.filter((t) => t.status === 'running');
      const completed = allTasks.filter((t) => t.status !== 'running');
      const pending = ctx.taskQueue.pendingCount;
      const lines: string[] = [];
      if (running.length > 0) {
        lines.push(`Running (${running.length}):`);
        for (const t of running) {
          const elapsed = ((Date.now() - new Date(t.startedAt).getTime()) / 1000).toFixed(0);
          lines.push(`  ${t.id}: ${t.description} (${elapsed}s)`);
        }
      }
      if (pending > 0) {
        lines.push(`Awaiting review: ${pending} result${pending > 1 ? 's' : ''}`);
      }
      if (completed.length > 0) {
        lines.push(`History (${completed.length}):`);
        for (const t of completed.slice(-5)) {
          lines.push(`  ${t.id}: ${t.description} [${t.status}]`);
        }
      }
      ctx.addSystemMessage(lines.join('\n'));
      return true;
    },
  },

  // --- /model ---
  {
    match: (input) => input === '/model' || input.startsWith('/model '),
    execute: (input, ctx) => {
      if (input === '/model') {
        const list = ctx.availableModels.map((m) => (m === ctx.model ? `> ${m}` : `  ${m}`)).join('\n');
        ctx.addSystemMessage(`Current model: ${ctx.model}\nAvailable:\n${list}\nUsage: /model <name>`);
        return true;
      }
      const requested = input.slice('/model '.length).trim();
      const result = setModel(requested, ctx);
      ctx.addSystemMessage(result.message ?? `Model switched to: ${ctx.model}`);
      return true;
    },
  },

  // --- /reflect ---
  {
    match: '/reflect',
    execute: (_input, ctx) => {
      ctx.addSystemMessage('Running reflection — mining patterns from recent episodes…');
      void (async () => {
        try {
          const { runReflection } = await import('./reflection.js');
          const result = await Promise.race([
            runReflection(ctx.provider, ctx.workspacePath),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Reflection timed out after 30s')), 30_000),
            ),
          ]);

          const lines: string[] = ['Reflection complete.'];
          lines.push(`  Patterns found: ${result.patternsFound}`);
          lines.push(`  MEMORY.md updated: ${result.memoryUpdated ? 'yes' : 'no'}`);
          lines.push(`  TODO.md updated:   ${result.todoUpdated ? 'yes' : 'no'}`);
          if (result.insights.length > 0) {
            lines.push('  Insights:');
            for (const insight of result.insights) {
              lines.push(`    • ${insight}`);
            }
          }
          if (result.patternsFound === 0) {
            lines.push('  (No recurring patterns found — need more episodes or they are already documented.)');
          }
          ctx.addSystemMessage(lines.join('\n'));
        } catch (err: unknown) {
          const msg = (err as { message?: string }).message ?? 'unknown error';
          ctx.addSystemMessage(`Reflection failed: ${msg}`);
        }
      })();
      return true;
    },
  },

  // --- /help ---
  {
    match: '/help',
    execute: (_input, ctx) => {
      ctx.addSystemMessage(
        'Commands:\n' +
        '  /reset              Clear conversation\n' +
        '  /restart            Restart server (picks up code changes)\n' +
        '  /reload             Typecheck → build → restart (explicit full reload)\n' +
        '  /refresh            Reload workspace files\n' +
        '  /compact            Compact context (free up space)\n' +
        '  /reflect            Mine patterns from episodes → update MEMORY.md & TODO.md\n' +
        '  /reasoning on|off   Toggle reasoning\n' +
        '  /effort <level>     Set effort (low/medium/high/max)\n' +
        '  /short on|off       Short/voice mode (brief plain-text replies)\n' +
        '  /model [name]       Show or switch model\n' +
        '  /image <path> [msg] Send an image with optional message\n' +
        '  /usage              Show token usage (session + lifetime)\n' +
        '  /context            Show context window breakdown by component\n' +
        '  /tasks              Show background tasks\n' +
        '  /profiles           List profiles\n' +
        '  /profile <name>     Switch profile\n' +
        '  /profile create <n> Create new profile\n' +
        '  /save               Save current session\n' +
        '  /sessions           List saved sessions\n' +
        '  /load <id>          Load a saved session\n' +
        '  Esc                 Cancel generation / clear input\n' +
        '  Ctrl+C              Cancel / clear input (x2 to exit)',
      );
      return true;
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Try to handle `input` as a slash command.
 * Returns true if a command matched (even if it's an unknown `/...`).
 */
export function handleCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim();

  for (const cmd of commands) {
    const matches = typeof cmd.match === 'string'
      ? trimmed === cmd.match
      : cmd.match(trimmed);
    if (matches && cmd.execute(trimmed, ctx)) return true;
  }

  // Catch-all for unknown /commands
  if (trimmed.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${trimmed}\nType /help for available commands.`);
    return true;
  }

  return false;
}
