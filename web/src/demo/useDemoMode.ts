import { useEffect, useRef } from 'react';
import { MockWebSocket } from './MockWebSocket';
import { DemoPlaybackEngine } from './DemoPlaybackEngine';
import { DEMO_SCENARIO } from './scenario';
import { useDemoPlaybackStore } from './demoStore';

/** Singleton mock WS — created once, shared with useWebSocket */
let mockWs: MockWebSocket | null = null;

/** Singleton engine — exposed for scrubber to call seekTo/pause/resume */
let demoEngine: DemoPlaybackEngine | null = null;

export function isDemo(): boolean {
  return import.meta.env.VITE_DEMO === 'true';
}

export function getDemoWebSocket(): MockWebSocket {
  if (!mockWs) {
    mockWs = new MockWebSocket('ws://demo/ws');
  }
  return mockWs;
}

export function getDemoEngine(): DemoPlaybackEngine | null {
  return demoEngine;
}

/**
 * React hook that bootstraps the demo playback engine.
 * No-ops when VITE_DEMO is not set. Call unconditionally in App.
 */
export function useDemoMode(): void {
  const engineRef = useRef<DemoPlaybackEngine | null>(null);

  useEffect(() => {
    if (!isDemo()) return;

    // Set data attribute for CSS targeting (DEMO badge)
    document.body.setAttribute('data-demo', '');

    const ws = getDemoWebSocket();
    const engine = new DemoPlaybackEngine(DEMO_SCENARIO, ws);
    engineRef.current = engine;
    demoEngine = engine;

    // Read initial URL hash — if it matches a section, seek there after start
    const initialHash = location.hash.slice(1); // strip leading #

    // Small delay to let React mount everything before starting playback
    const startTimer = setTimeout(() => {
      if (initialHash && engine.sectionIndex.has(initialHash)) {
        // Seek to the section and auto-resume playback from there
        engine.seekToSection(initialHash);
        engine.resume();
      } else {
        void engine.play();
      }
    }, 500);

    // Listen for hash changes (user edits URL or clicks a link)
    const onHashChange = () => {
      const hash = location.hash.slice(1);
      if (hash && engine.sectionIndex.has(hash)) {
        engine.seekToSection(hash);
        engine.resume();
      }
    };
    window.addEventListener('hashchange', onHashChange);

    return () => {
      clearTimeout(startTimer);
      window.removeEventListener('hashchange', onHashChange);
      engine.stop();
      demoEngine = null;
      useDemoPlaybackStore.getState().setCurrentStep(0);
      document.body.removeAttribute('data-demo');
    };
  }, []);
}
