/**
 * Picture-in-Picture hook with two modes:
 *
 *   auto   — Acquires a silent background mic stream and registers a Media
 *            Session handler so Chrome auto-opens PiP when the user switches
 *            tabs.  Chrome requires an active getUserMedia stream for the
 *            enterpictureinpicture action to fire.
 *   manual — No auto-PiP; the user clicks the Float button to open PiP.
 *
 * The Float button is always available regardless of mode.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settings';

const PIP_WIDTH = 420;
const PIP_HEIGHT = 720;

export interface PiPControls {
  /** Manually open a PiP window. Returns false if unsupported or already open. */
  openPiP: () => Promise<boolean>;
  /** Whether the Document PiP API is available in this browser. */
  pipSupported: boolean;
}

function isPiPSupported(): boolean {
  return 'documentPictureInPicture' in window;
}

/** Create and populate a Document PiP window with an iframe to '/'. */
async function createPiPWindow(): Promise<Window> {
  const pipWindow = await documentPictureInPicture.requestWindow({
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

  return pipWindow;
}

export function usePiP(): PiPControls {
  const pipMode = useSettingsStore(s => s.getClientSetting('AIGENT_PIP_MODE')) as string;
  const pipWindowRef = useRef<Window | null>(null);
  const supported = isPiPSupported();

  const openPiP = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    if (pipWindowRef.current && !pipWindowRef.current.closed) return false;

    try {
      const pipWindow = await createPiPWindow();
      pipWindowRef.current = pipWindow;
      pipWindow.addEventListener('pagehide', () => {
        pipWindowRef.current = null;
      });
      return true;
    } catch (err) {
      console.warn('[aigent] PiP failed:', err);
      return false;
    }
  }, [supported]);

  // Auto mode: generate a silent audio stream via Web Audio API and play it
  // through an *unmuted* <audio> element.  Chrome considers this "active media
  // playback" and fires the Media Session enterpictureinpicture handler when
  // the user switches tabs — giving us transient user-activation to call
  // documentPictureInPicture.requestWindow().
  //
  // Why not getUserMedia?  A muted <audio> with a mic stream doesn't count as
  // "playing media" for Media Session purposes.  Using Web Audio silence means
  // no mic permission needed, no mic indicator, and no audible output.
  useEffect(() => {
    if (pipMode !== 'auto' || !supported) return;
    if (!('mediaSession' in navigator)) return;

    let audioCtx: AudioContext | null = null;
    let audio: HTMLAudioElement | null = null;
    let cancelled = false;

    const setup = async () => {
      // Build a silent audio graph: oscillator → gain(0) → MediaStreamDestination
      audioCtx = new AudioContext();
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0; // truly silent — no audible output
      const dest = audioCtx.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(dest);
      oscillator.start();

      if (cancelled) {
        oscillator.stop();
        await audioCtx.close();
        return;
      }

      // Play the silent stream through an unmuted <audio> element.
      // Chrome sees this as active media playback.
      audio = new Audio();
      audio.srcObject = dest.stream;
      audio.volume = 1; // must not be muted for Media Session to engage
      audio.play().catch(() => { /* autoplay may be blocked */ });

      const handler = async () => {
        if (pipWindowRef.current && !pipWindowRef.current.closed) return;
        try {
          const pipWindow = await createPiPWindow();
          pipWindowRef.current = pipWindow;
          pipWindow.addEventListener('pagehide', () => {
            pipWindowRef.current = null;
          });
        } catch (err) {
          console.warn('[aigent] Auto-PiP failed:', err);
        }
      };

      navigator.mediaSession.setActionHandler('enterpictureinpicture', handler);
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'aigent' });
      } catch { /* not available in all contexts */ }
    };

    setup();

    return () => {
      cancelled = true;
      navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      if (audio) {
        audio.pause();
        audio.srcObject = null;
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
      }
    };
  }, [pipMode, supported]);

  return { openPiP, pipSupported: supported };
}
