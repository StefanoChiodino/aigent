/**
 * Picture-in-Picture hook — opens a Document PiP window on button click.
 * The Float button lives in the header next to Settings.
 */

import { useCallback } from 'react';

const PIP_WIDTH = 480;
const PIP_HEIGHT = 720;

export interface PiPControls {
  openPiP: () => Promise<boolean>;
  pipSupported: boolean;
}

// Suppress PiP logic inside the PiP iframe itself.
const IS_IFRAME = window !== window.top;

const supported = !IS_IFRAME && 'documentPictureInPicture' in window;

let pipWindow: Window | null = null;

export function usePiP(): PiPControls {
  const openPiP = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
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

      pipWindow.addEventListener('pagehide', () => { pipWindow = null; });
      return true;
    } catch (err) {
      console.warn('[aigent] PiP failed:', err);
      return false;
    }
  }, []);

  return { openPiP, pipSupported: supported };
}

/** Reset module-level state between tests. */
export function __resetForTest() {
  pipWindow = null;
}
