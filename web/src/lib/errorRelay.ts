/**
 * Error relay — captures browser console errors, uncaught exceptions, and
 * unhandled promise rejections, then forwards them over the WebSocket as
 * `browser_error` commands so the server can log them and echo them back to chat.
 *
 * Only active when `debug_browser_errors` is enabled in settings.
 */

type SendFn = (data: Record<string, unknown>) => void;

let active = false;
let sendFn: SendFn | null = null;
let origWarn: typeof console.warn | null = null;
let origError: typeof console.error | null = null;

function relay(level: 'warn' | 'error', args: unknown[], source?: string): void {
  if (!active || !sendFn) return;
  const message = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  sendFn({ type: 'browser_error', level, message, ...(source ? { source } : {}) });
}

function onError(event: ErrorEvent): void {
  relay('error', [event.message], event.filename ? `${event.filename}:${event.lineno}` : undefined);
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason = event.reason instanceof Error
    ? `${event.reason.name}: ${event.reason.message}`
    : String(event.reason);
  relay('error', [`Unhandled rejection: ${reason}`]);
}

export function setupErrorRelay(send: SendFn): void {
  if (active) return;
  active = true;
  sendFn = send;

  origWarn = console.warn;
  origError = console.error;

  console.warn = (...args: unknown[]) => {
    origWarn!(...args);
    relay('warn', args);
  };

  console.error = (...args: unknown[]) => {
    origError!(...args);
    relay('error', args);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}

export function teardownErrorRelay(): void {
  if (!active) return;
  active = false;
  sendFn = null;

  if (origWarn) { console.warn = origWarn; origWarn = null; }
  if (origError) { console.error = origError; origError = null; }

  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onUnhandledRejection);
}
