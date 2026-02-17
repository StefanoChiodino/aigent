/**
 * Graceful restart handling.
 *
 * When the supervisor sends SIGUSR1, we set a flag.
 * The agent checks this flag between conversation turns
 * and exits cleanly when it's safe to restart.
 */

let _restartPending = false;
let _onRestartRequest: (() => void) | null = null;

/** Check if a restart has been requested */
export function isRestartPending(): boolean {
  return _restartPending;
}

/** Register a callback for when restart is requested */
export function onRestartRequested(callback: () => void): void {
  _onRestartRequest = callback;
}

/** Install the SIGUSR1 handler. Call once at startup. */
export function installRestartHandler(): void {
  process.on('SIGUSR1', () => {
    _restartPending = true;
    _onRestartRequest?.();
  });
}

/** Perform a graceful restart (exit so supervisor respawns us) */
export function gracefulRestart(): never {
  // Exit with code 99 to distinguish from normal exit
  // Supervisor treats any exit during restartPending as a restart
  process.exit(99);
}
