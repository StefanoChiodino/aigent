/**
 * Lightweight structured logger for aigent.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('server');
 *   log.info('Listening', { port: 3000 });
 *   log.debug('Socket data', { bytes: 1024 });
 *
 * Output format (one line per entry):
 *   2024-01-15T10:30:45.123Z [INFO] [server] Listening port=3000
 *
 * The logger writes to console.error(). Both the gatekeeper and worker
 * redirect console.error to their respective log files, so the logger
 * works transparently in both processes.
 *
 * Log levels: DEBUG < INFO < WARN < ERROR
 * Default level: INFO
 * Set AIGENT_DEBUG=1 to enable DEBUG level.
 * Set AIGENT_LOG_LEVEL=WARN for finer control.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function getMinLevel(): LogLevel {
  if (process.env['AIGENT_DEBUG'] === '1') return 'DEBUG';
  const explicit = process.env['AIGENT_LOG_LEVEL']?.toUpperCase();
  if (explicit && explicit in LEVEL_ORDER) return explicit as LogLevel;
  return 'INFO';
}

const MIN_LEVEL = getMinLevel();

function formatKV(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === 'string' && v.includes(' ') ? JSON.stringify(v) : v}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function emit(level: LogLevel, component: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const ts = new Date().toISOString();
  console.error(`${ts} [${level}] [${component}] ${msg}${formatKV(data)}`);
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Time an async operation and log its duration. */
  time<T>(msg: string, fn: () => T | Promise<T>, data?: Record<string, unknown>): Promise<T>;
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, data) => emit('DEBUG', component, msg, data),
    info: (msg, data) => emit('INFO', component, msg, data),
    warn: (msg, data) => emit('WARN', component, msg, data),
    error: (msg, data) => emit('ERROR', component, msg, data),
    async time<T>(msg: string, fn: () => T | Promise<T>, data?: Record<string, unknown>): Promise<T> {
      const start = performance.now();
      try {
        const result = await fn();
        const ms = (performance.now() - start).toFixed(0);
        emit('INFO', component, `${msg}`, { ...data, ms });
        return result;
      } catch (err) {
        const ms = (performance.now() - start).toFixed(0);
        emit('ERROR', component, `${msg} failed`, { ...data, ms, error: (err as Error).message });
        throw err;
      }
    },
  };
}
