/**
 * Picture-in-Picture hook — opens a Document PiP window on button click.
 * The Float button lives in the header next to Settings.
 *
 * Also exports standalone `tryOpenPiP()` / `isPiPOpen()` for programmatic use
 * (e.g. the pip_suggestion prompt and the "Float & Approve" permission button).
 */

import { useCallback } from 'react';
import { useConnectionStore } from '../stores/connection';

const PIP_WIDTH = 480;
const PIP_HEIGHT = 720;

export interface PiPControls {
  openPiP: () => Promise<boolean>;
  pipSupported: boolean;
}

// Suppress PiP logic inside the PiP iframe itself.
const IS_IFRAME = window !== window.top;

export const pipSupported = !IS_IFRAME && 'documentPictureInPicture' in window;

let pipWindow: Window | null = null;

/** Report PiP open/close state to the server so the gatekeeper can skip pip_suggestion. */
function reportPiPState(open: boolean): void {
  useConnectionStore.getState().send({ type: 'pip_state', open });
}

/**
 * Open a Document PiP window with the aigent web UI.
 * Requires user activation (transient user gesture).
 * Returns true on success, false on failure or if already open.
 */
export async function tryOpenPiP(): Promise<boolean> {
  if (!pipSupported) return false;
  if (pipWindow && !pipWindow.closed) return false;

  try {
    pipWindow = await documentPictureInPicture.requestWindow({
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
    });

    const style = pipWindow.document.createElement('style');
    style.textContent = `
      *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #1a1a1a; }
      iframe { width: 100%; height: 100%; border: none; }
    `;
    pipWindow.document.head.appendChild(style);
    pipWindow.document.title = 'aigent';

    const iframe = pipWindow.document.createElement('iframe');
    iframe.src = '/';
    iframe.allow = 'microphone; clipboard-write; clipboard-read; display-capture; camera';
    pipWindow.document.body.appendChild(iframe);

    pipWindow.addEventListener('pagehide', () => {
      pipWindow = null;
      reportPiPState(false);
    });

    reportPiPState(true);
    return true;
  } catch (err) {
    console.warn('[aigent] PiP failed:', err);
    return false;
  }
}

/** Check if a PiP window is currently open. */
export function isPiPOpen(): boolean {
  return pipWindow !== null && !pipWindow.closed;
}

export function usePiP(): PiPControls {
  const openPiP = useCallback(() => tryOpenPiP(), []);
  return { openPiP, pipSupported };
}

/** Reset module-level state between tests. */
export function __resetForTest() {
  pipWindow = null;
}
