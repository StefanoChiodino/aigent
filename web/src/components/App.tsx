import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import { isDemo, useDemoMode } from '../demo/useDemoMode';
import { DemoScrubber } from '../demo/DemoScrubber';
import { useUIStore } from '../stores/ui';
import { useChatStore } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';
import { useTTS } from '../hooks/useTTS';
import { useWakeLock } from '../hooks/useWakeLock';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { InputArea } from './InputArea';
import { CircuitBackground } from './backgrounds/CircuitBackground';
import { MatrixBackground } from './backgrounds/MatrixBackground';
import { ConstellationBackground } from './backgrounds/ConstellationBackground';
import { TopologyBackground } from './backgrounds/TopologyBackground';
import { EmberBackground } from './backgrounds/EmberBackground';
import { SpectrumBackground } from './backgrounds/SpectrumBackground';
import { OscilloscopeBackground } from './backgrounds/OscilloscopeBackground';
import { CircularSpectrumBackground } from './backgrounds/CircularSpectrumBackground';
import { MilkdropBackground } from './backgrounds/MilkdropBackground';
import { FirefliesBackground } from './backgrounds/FirefliesBackground';
import { RainBackground } from './backgrounds/RainBackground';
import { NeonGridBackground } from './backgrounds/NeonGridBackground';
import { LavaLampBackground } from './backgrounds/LavaLampBackground';
import { PCBBackground } from './backgrounds/PCBBackground';
import { NeuronBackground } from './backgrounds/NeuronBackground';
import { PermissionModal } from './modals/PermissionModal';
import { SettingsModal } from './modals/SettingsModal';
import { ContextInspector } from './modals/ContextInspector';
import { TaskResultPanel } from './modals/TaskResultPanel';
import { ShortcutsModal } from './modals/ShortcutsModal';
import { TraceInspector } from './modals/TraceInspector';
import { TasksInspector } from './modals/TasksInspector';

const THEME_OPTIONS = ['aurora', 'spectrum', 'oscilloscope', 'circular', 'milkdrop', 'circuit', 'matrix', 'constellation', 'topology', 'ember', 'fireflies', 'rain', 'neongrid', 'lavalamp', 'pcb', 'neuron'];

export function App() {
  useWebSocket();
  useDemoMode();
  useWakeLock();

  // Wire TTS auto-speak to streaming text changes
  const { flushStream } = useTTS();
  const flushRef = useRef(flushStream);
  flushRef.current = flushStream;
  useEffect(() => {
    let prev = '';
    let wasActive = false;
    return useChatStore.subscribe((s) => {
      const text = s.streaming.text;
      const active = s.streaming.active;
      if (text && text !== prev) { prev = text; flushRef.current(); }
      if (wasActive && !active) flushRef.current(true); // final flush
      if (!text) prev = '';
      wasActive = active;
    });
  }, []);

  const isLoading = useUIStore(s => s.isLoading);
  const theme = useSettingsStore(s => s.getClientSetting('AIGENT_THEME')) as string || 'aurora';
  const rotateMins = useSettingsStore(s => s.getClientSetting('AIGENT_THEME_ROTATE_MINS')) as number || 0;
  const setClientSetting = useSettingsStore(s => s.setClientSetting);

  // Theme rotation
  useEffect(() => {
    if (!rotateMins || rotateMins <= 0) return;
    const ms = rotateMins * 60 * 1000;
    const id = setInterval(() => {
      const current = useSettingsStore.getState().getClientSetting('AIGENT_THEME') as string || 'aurora';
      const idx = THEME_OPTIONS.indexOf(current);
      setClientSetting('AIGENT_THEME', THEME_OPTIONS[(idx + 1) % THEME_OPTIONS.length]);
    }, ms);
    return () => clearInterval(id);
  }, [rotateMins, setClientSetting]);

  // Sync data-working attribute on body for CSS / test selectors
  useEffect(() => {
    if (isLoading) {
      document.body.setAttribute('data-working', '');
    } else {
      document.body.removeAttribute('data-working');
    }
  }, [isLoading]);

  // Sync theme attribute on body for CSS selectors
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div id="app">
      {theme === 'aurora' && (
        <div className="bokeh" aria-hidden="true">
          <span className="b1" /><span className="b2" /><span className="b3" />
          <span className="b4" /><span className="b5" /><span className="b6" />
          <span className="b7" />
        </div>
      )}
      {theme === 'circuit' && <CircuitBackground />}
      {theme === 'matrix' && <MatrixBackground />}
      {theme === 'constellation' && <ConstellationBackground />}
      {theme === 'topology' && <TopologyBackground />}
      {theme === 'ember' && <EmberBackground />}
      {theme === 'spectrum' && <SpectrumBackground />}
      {theme === 'oscilloscope' && <OscilloscopeBackground />}
      {theme === 'circular' && <CircularSpectrumBackground />}
      {theme === 'milkdrop' && <MilkdropBackground />}
      {theme === 'fireflies' && <FirefliesBackground />}
      {theme === 'rain' && <RainBackground />}
      {theme === 'neongrid' && <NeonGridBackground />}
      {theme === 'lavalamp' && <LavaLampBackground />}
      {theme === 'pcb' && <PCBBackground />}
      {theme === 'neuron' && <NeuronBackground />}
      <Header />
      <div id="body">
        <Sidebar />
        <div id="main-col">
          <ChatArea />
          <InputArea />
        </div>
      </div>
      {createPortal(<PermissionModal />, document.body)}
      {createPortal(<SettingsModal />, document.body)}
      {createPortal(<ContextInspector />, document.body)}
      {createPortal(<TaskResultPanel />, document.body)}
      {createPortal(<ShortcutsModal />, document.body)}
      {createPortal(<TraceInspector />, document.body)}
      {createPortal(<TasksInspector />, document.body)}
      {isDemo() && createPortal(
        <>
          <div id="demo-banner">
            <span className="demo-label">DEMO</span>
            <a
              href="https://github.com/StefanoChiodino/aigent"
              target="_blank"
              rel="noopener noreferrer"
              className="demo-github"
              title="View on GitHub"
            >
              <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
            </a>
          </div>
          <DemoScrubber />
        </>,
        document.body,
      )}
    </div>
  );
}
