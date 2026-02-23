import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { useMic } from '../hooks/useMic';
import { useTTS } from '../hooks/useTTS';
import { captureScreenshot, registerScreenCapCallback, startScreenShare } from '../lib/screen';
import { COMMANDS } from '../lib/settings-schema';
import { CommandPalette } from './CommandPalette';
import { AtPalette, getAtStaticMatches } from './AtPalette';
import { AttachmentPreview } from './AttachmentPreview';
import type { CommandDef, AtItem, PendingAttachment } from '../types';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ALLOWED_TYPES = [...IMAGE_TYPES, 'application/pdf', 'text/plain', 'text/markdown'];
const MAX_ATTACHMENTS = 5;

let attachIdCounter = 0;

function guessMime(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown',
  };
  return map[ext ?? ''] ?? null;
}

export function InputArea() {
  const send = useConnectionStore(s => s.send);
  const isLoading = useUIStore(s => s.isLoading);
  const errorMsg = useUIStore(s => s.errorMsg);
  const setError = useUIStore(s => s.setError);
  const mountsList = useUIStore(s => s.mountsList);
  const thinkingLevel = useUIStore(s => s.thinkingLevel);
  const setCtxInspectorOpen = useUIStore(s => s.setCtxInspectorOpen);
  const pendingAttachments = useUIStore(s => s.pendingAttachments);
  const addAttachment = useUIStore(s => s.addAttachment);
  const removeAttachment = useUIStore(s => s.removeAttachment);
  const clearAttachments = useUIStore(s => s.clearAttachments);
  const micState = useVoiceStore(s => s.micState);
  const vadActive = useVoiceStore(s => s.vadActive);
  const ttsPlaying = useVoiceStore(s => s.ttsPlaying);
  const micSticky = useVoiceStore(s => s.micSticky);
  const setMicSticky = useVoiceStore(s => s.setMicSticky);

  const [inputValue, setInputValue] = useState('');
  const [paletteSelected, setPaletteSelected] = useState(0);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [atTriggerPos, setAtTriggerPos] = useState(-1);
  const [atQuery, setAtQuery] = useState('');
  const [atSelected, setAtSelected] = useState(0);
  const atItemsRef = useRef<AtItem[]>([]);
  const [screenCapActive, setScreenCapActive] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const micBaseTextRef = useRef('');
  const lastMicTextRef = useRef('');

  const { stopAll: ttsStopAll } = useTTS();
  const { startMic, stopMic, abortMic } = useMic(useCallback((text: string) => {
    lastMicTextRef.current = text;
    setInputValue(micBaseTextRef.current ? micBaseTextRef.current + ' ' + text : text);
  }, []));

  useEffect(() => {
    registerScreenCapCallback(setScreenCapActive);
  }, []);

  // Auto-grow textarea
  const autoGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  useEffect(() => {
    autoGrow();
  }, [inputValue, autoGrow]);

  const computeAtTrigger = useCallback((text: string, caret: number) => {
    let trigPos = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') {
        if (i === 0 || /\s/.test(text[i - 1]!)) trigPos = i;
        break;
      }
      if (/\s/.test(ch!)) break;
    }
    if (trigPos === -1) {
      setAtTriggerPos(-1);
      setAtQuery('');
    } else {
      setAtTriggerPos(trigPos);
      setAtQuery(text.slice(trigPos + 1, caret).toLowerCase());
    }
  }, []);

  const submitMessage = useCallback((useThinkingOverride = false) => {
    if (micState === 'recording') abortMic();
    const text = inputValue.trim();
    if (!text && pendingAttachments.length === 0) return;

    // Handle /context locally
    if (text === '/context') {
      setCtxInspectorOpen(true);
      send({ type: 'context_breakdown_request' });
      setInputValue('');
      return;
    }

    const msg: Record<string, unknown> = { type: 'message', content: text };
    if (pendingAttachments.length > 0) {
      msg.attachments = pendingAttachments.map(a => ({
        name: a.name, mediaType: a.mediaType, data: a.data,
      }));
      clearAttachments();
    }
    if (useThinkingOverride) {
      msg.thinkingOverride = thinkingLevel === 'off' ? 'high' : 'off';
    }

    send(msg);
    setInputValue('');
    setPaletteSelected(0);
    setAtTriggerPos(-1);
    setAtQuery('');
    setTimeout(() => inputRef.current?.focus(), 0);

    if (micSticky) setTimeout(() => { void startMic(true); }, 100);
  }, [
    inputValue, pendingAttachments, micState, thinkingLevel, micSticky,
    send, abortMic, clearAttachments, startMic, setCtxInspectorOpen,
  ]);

  const addFile = useCallback((file: File) => {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) return;
    let mime = file.type;
    if (!mime) mime = guessMime(file.name) ?? '';
    if (!ALLOWED_TYPES.includes(mime)) return;

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      const dataUrl = mime.startsWith('image/') ? result : undefined;
      const att: PendingAttachment = {
        id: `att_${++attachIdCounter}`,
        name: file.name,
        mediaType: mime,
        data: base64,
        dataUrl,
        size: file.size,
      };
      addAttachment(att);
    };
    reader.readAsDataURL(file);
  }, [pendingAttachments.length, addAttachment]);

  const handleScreenCap = useCallback(async () => {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) return;
    try {
      if (!screenCapActive) await startScreenShare();
      const base64 = captureScreenshot();
      if (!base64) return;
      const dataUrl = `data:image/png;base64,${base64}`;
      addAttachment({
        id: `att_${++attachIdCounter}`,
        name: 'screenshot.png',
        mediaType: 'image/png',
        data: base64,
        dataUrl,
        size: Math.round(base64.length * 0.75),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError('Screen capture failed');
      }
    }
  }, [pendingAttachments.length, screenCapActive, addAttachment, setError]);

  const toggleMicSticky = useCallback(() => {
    const wasSticky = micSticky;
    setMicSticky(!micSticky);
    if (!micSticky && micState === 'idle') void startMic();
    else if (wasSticky && micSticky && micState === 'recording') void stopMic();
  }, [micSticky, micState, setMicSticky, startMic, stopMic]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(true);
      if (e.code === 'Backquote' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        toggleMicSticky();
        return;
      }
      if (e.code === 'Backquote' && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (micState === 'recording') { setMicSticky(false); void stopMic(); }
        else void startMic();
        return;
      }
      const inputFocused = document.activeElement === inputRef.current;
      if (!inputFocused && (e.code === 'Backquote' || e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (micState === 'recording') { setMicSticky(false); void stopMic(); }
        else void startMic();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false);
    };
    const onBlur = () => setCtrlHeld(false);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [micState, micSticky, toggleMicSticky, setMicSticky, startMic, stopMic]);

  // Notification permission
  useEffect(() => {
    const handler = () => {
      if ('Notification' in window && Notification.permission === 'default') {
        void Notification.requestPermission();
      }
    };
    document.addEventListener('click', handler, { once: true });
    document.addEventListener('keydown', handler, { once: true });
  }, []);

  const showCancel = isLoading || ttsPlaying;
  const currentlyOn = thinkingLevel !== 'off';
  const willThink = ctrlHeld ? !currentlyOn : currentlyOn;

  const paletteItems = (() => {
    if (!inputValue.startsWith('/')) return [];
    const spaceIdx = inputValue.indexOf(' ');
    const prefix = spaceIdx > 0 ? inputValue.slice(0, spaceIdx) : inputValue;
    if (spaceIdx > 0 && COMMANDS.some(c => c.name === prefix)) return [];
    return COMMANDS.filter(c => c.name.startsWith(prefix.toLowerCase()));
  })();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @ palette nav
    if (atTriggerPos !== -1) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setAtSelected(s => Math.max(0, s - 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtSelected(s => s + 1); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        // atItemsRef may not yet be populated if the effect hasn't run; fall back to sync static items
        const items = atItemsRef.current.length > 0 ? atItemsRef.current : getAtStaticMatches(atQuery);
        const clampedIdx = items.length > 0 ? Math.min(atSelected, items.length - 1) : 0;
        const item = items[clampedIdx] ?? items[0];
        if (item) handleAtComplete(item);
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAtTriggerPos(-1); return; }
    }
    // Command palette nav
    if (paletteItems.length > 0 && !paletteHidden) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSelected(s => Math.max(0, s - 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSelected(s => Math.min(paletteItems.length - 1, s + 1)); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const item = paletteItems[paletteSelected];
        if (item) handlePaletteComplete(item);
        return;
      }
    }
    // While dictating: Enter stops mic and sends
    if (micState === 'recording' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void stopMic().then(() => submitMessage());
      return;
    }
    // Ctrl+Enter: thinking override
    if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      submitMessage(true);
      return;
    }
    // Enter: send
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (paletteItems.length > 0 && !paletteHidden) {
        const trimmed = inputValue.trim();
        if (!COMMANDS.some(c => c.name === trimmed)) {
          const item = paletteItems[paletteSelected];
          if (item) { handlePaletteComplete(item); return; }
        }
      }
      submitMessage();
      return;
    }
    if (e.key === 'Escape') {
      if (paletteItems.length > 0 && !paletteHidden) {
        // First Escape: hide palette but keep text
        setPaletteHidden(true);
        setPaletteSelected(0);
      } else if (isLoading) {
        send({ type: 'cancel' });
      } else {
        setInputValue('');
        setPaletteHidden(false);
      }
    }
  };

  const handlePaletteComplete = (item: CommandDef) => {
    const newVal = item.argHint ? item.name + ' ' : item.name;
    setInputValue(newVal);
    setPaletteSelected(0);
    if (!item.argHint) setTimeout(() => submitMessage(), 0);
    inputRef.current?.focus();
  };

  const handleAtComplete = (item: AtItem) => {
    const caret = inputRef.current?.selectionStart ?? inputValue.length;
    const newVal = inputValue.slice(0, atTriggerPos) + item.insert + ' ' + inputValue.slice(caret);
    setInputValue(newVal);
    setAtTriggerPos(-1);
    setAtQuery('');
    setAtSelected(0);
    const newCaret = atTriggerPos + item.insert.length + 1;
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
      if (item.insert === '@screen') void startScreenShare().catch(() => { /* user can remove @screen manually */ });
    }, 0);
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputValue(val);
    const caret = e.target.selectionStart ?? val.length;
    computeAtTrigger(val, caret);
    setPaletteSelected(0);
    setPaletteHidden(false);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      let mime = file.type;
      if (!mime) mime = guessMime(file.name) ?? '';
      if (ALLOWED_TYPES.includes(mime)) {
        e.preventDefault();
        addFile(file);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).classList.add('drag-over');
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('drag-over');
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of files) addFile(file);
  };

  return (
    <div
      id="input-area"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div id="error-bar" className={errorMsg ? '' : 'hidden'}>{errorMsg}</div>

      <AttachmentPreview />

      <CommandPalette
        text={inputValue}
        hidden={paletteHidden}
        selected={paletteSelected}
        onSelect={setPaletteSelected}
        onComplete={handlePaletteComplete}
      />

      <AtPalette
        triggerPos={atTriggerPos}
        query={atQuery}
        mountsAvailable={mountsList.length > 0}
        selected={atSelected}
        onSelect={setAtSelected}
        onComplete={handleAtComplete}
        onItemsChange={useCallback((items: AtItem[]) => { atItemsRef.current = items; }, [])}
      />

      <div id="input-row">
        {/* Attach button */}
        <button id="attach" title="Attach file" onClick={() => fileInputRef.current?.click()}>
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M15.5 10.5l-5.5 5.5a4 4 0 01-5.657-5.657l6.364-6.364a2.5 2.5 0 013.535 3.535l-6.364 6.364a1 1 0 01-1.414-1.414l5.657-5.657"/>
          </svg>
        </button>
        <input
          ref={fileInputRef}
          id="file-input"
          type="file"
          multiple
          accept={ALLOWED_TYPES.join(',')}
          style={{ display: 'none' }}
          onChange={e => {
            const files = e.target.files;
            if (!files) return;
            for (const file of files) addFile(file);
            e.target.value = '';
          }}
        />

        {/* Textarea */}
        <textarea
          ref={inputRef}
          id="input"
          rows={1}
          placeholder={
            micState === 'recording' ? 'Listening…' :
            isLoading ? 'Agent is working…' : 'Message aigent…'
          }
          value={inputValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          autoFocus
        />

        {/* Mic area */}
        <div id="mic-sticky-group">
          <button
            id="mic"
            className={[
              micState === 'recording' ? 'recording' : '',
              micState === 'transcribing' ? 'transcribing' : '',
              vadActive ? 'vad-active' : '',
            ].filter(Boolean).join(' ')}
            title={micState === 'recording' ? 'Stop mic' : 'Start mic'}
            onClick={() => {
              if (micState === 'recording') { setMicSticky(false); void stopMic(); }
              else void startMic();
              inputRef.current?.focus();
            }}
          >
            {micState === 'idle' && (
              <svg className="icon-mic" viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
                <rect x="7" y="1" width="6" height="10" rx="3"/>
                <path d="M4 10a6 6 0 0012 0" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <line x1="10" y1="16" x2="10" y2="19" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="7" y1="19" x2="13" y2="19" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            )}
            {micState === 'recording' && (
              <svg className="icon-stop" viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
                <rect x="5" y="5" width="10" height="10" rx="1"/>
              </svg>
            )}
            {micState === 'transcribing' && (
              <svg className="icon-spinner" viewBox="0 0 24 24" width="18" height="18">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="28.3" strokeDashoffset="28.3" strokeLinecap="round"/>
              </svg>
            )}
          </button>

          <button
            id="mic-sticky"
            className={[micSticky ? 'active' : '', vadActive ? 'vad-active' : ''].filter(Boolean).join(' ')}
            title="Always-on mic"
            onClick={toggleMicSticky}
          >
            ∞
          </button>

          <button
            id="mic-clear"
            className={micState === 'recording' && lastMicTextRef.current ? '' : 'hidden'}
            title="Clear transcription"
            onClick={() => {
              lastMicTextRef.current = '';
              setInputValue(micBaseTextRef.current);
            }}
          >
            ✕
          </button>

          <span id="mic-capped" className="hidden">…</span>
        </div>

        {/* Screen cap */}
        <button
          id="screen-cap"
          className={screenCapActive ? 'active' : ''}
          title={screenCapActive ? 'Take screenshot' : 'Share screen & take screenshot'}
          onClick={() => void handleScreenCap()}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="4" width="18" height="12" rx="2"/>
            <circle cx="10" cy="10" r="2.5"/>
          </svg>
        </button>

        {/* Send / Cancel — both always in DOM, toggled via hidden class */}
        <button
          id="cancel"
          className={showCancel ? '' : 'hidden'}
          title="Stop"
          onClick={() => {
            ttsStopAll();
            if (isLoading) send({ type: 'cancel' });
          }}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
            <rect x="5" y="5" width="10" height="10" rx="1"/>
          </svg>
        </button>
        <button
          id="send"
          className={[showCancel ? 'hidden' : '', ctrlHeld ? 'thinking-override' : ''].filter(Boolean).join(' ')}
          title={ctrlHeld ? (currentlyOn ? 'Send without thinking' : 'Send with thinking') : 'Send'}
          onClick={() => submitMessage(ctrlHeld)}
        >
          <svg className={`icon-brain${willThink ? '' : ' hidden'}`} viewBox="0 0 20 20" width="18" height="18" fill="none">
            <ellipse cx="10" cy="10" rx="7" ry="5.5" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="7" cy="9" r="1.2" fill="currentColor"/>
            <circle cx="13" cy="9" r="1.2" fill="currentColor"/>
            <path d="M7 12 Q10 14 13 12" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
          <svg className={`icon-arrow${willThink ? ' hidden' : ''}`} viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
            <path d="M10 2l8 8H12v8H8v-8H2z"/>
          </svg>
        </button>

        <span id="hint-ctrl" style={{ display: 'none' }}>{currentlyOn ? 'quick' : 'think'}</span>
      </div>
    </div>
  );
}
