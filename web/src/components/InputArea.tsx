import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useConnectionStore } from '../stores/connection';
import { isDemo } from '../demo/useDemoMode';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { useMic } from '../hooks/useMic';
import { useTTS } from '../hooks/useTTS';
import { captureScreenshot, registerScreenCapCallback, startScreenShare, stopScreenShare } from '../lib/screen';
import { COMMANDS } from '../lib/settings-schema';
import { CommandPalette } from './CommandPalette';
import { AtPalette, getAtStaticMatches } from './AtPalette';
import { AttachmentPreview } from './AttachmentPreview';
import type { CommandDef, AtItem, PendingAttachment } from '../types';

/** Escape HTML special chars */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Highlight input text for the overlay: style markdown syntax and @mentions.
 * Returns HTML — must only be used with dangerouslySetInnerHTML.
 *
 * Supported: `code`, **bold**, __bold__, *italic*, _italic_, ~~strike~~,
 *            # headings, @mentions, /file/paths
 */
function highlightInputText(text: string): string {
  // Process line by line so heading detection is per-line
  const lines = text.split('\n');
  const processedLines = lines.map(line => highlightLine(line));
  return processedLines.join('\n') + '\n'; // trailing newline prevents height collapse
}

function highlightLine(line: string): string {
  // Heading: # / ## / ### at start of line
  const headingMatch = line.match(/^(#{1,3})(\s.*)$/);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const rest = headingMatch[2]!;
    return `<span class="input-hl-h${level}">${esc(headingMatch[1]!)}${highlightInline(rest)}</span>`;
  }
  return highlightInline(line);
}

/** Apply inline markdown highlighting to a string that contains no newlines. */
function highlightInline(text: string): string {
  // Tokenise: extract backtick spans first (they're opaque — no inner parsing)
  // Then apply other patterns to the non-code segments.
  const parts = text.split(/(`[^`]*`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // backtick code span
      return `<span class="input-hl-code">${esc(part)}</span>`;
    }
    // Plain segment — apply remaining patterns in order
    return applyInlinePatterns(esc(part));
  }).join('');
}

/** Apply bold / italic / strike / @mention patterns to an already-escaped segment.
 * Processes text in passes, always re-splitting on existing span tags so that
 * later patterns never match across already-inserted HTML. */
function applyInlinePatterns(html: string): string {
  // Each pass: split the string into [text, span, text, span, ...] segments,
  // apply the pattern only to text segments, then rejoin.
  function applyPattern(
    input: string,
    pattern: RegExp,
    replacer: (match: string, ...groups: string[]) => string,
  ): string {
    // Split on existing span tags to isolate already-processed regions
    const segments = input.split(/(<span[^>]*>.*?<\/span>)/s);
    return segments.map((seg, i) => {
      if (i % 2 === 1) return seg; // it's an existing span — leave it alone
      return seg.replace(pattern, replacer as (...args: unknown[]) => string);
    }).join('');
  }

  // Order matters: bold before italic so ** isn't parsed as two *.
  html = applyPattern(html,
    /~~([^~\n]+)~~/g,
    (_, g1) => `<span class="input-hl-strike">~~${g1}~~</span>`);
  html = applyPattern(html,
    /\*\*([^*\n]+)\*\*/g,
    (_, g1) => `<span class="input-hl-bold">**${g1}**</span>`);
  html = applyPattern(html,
    /(?<![\w])__([^_\n]+)__(?![\w])/g,
    (_, g1) => `<span class="input-hl-bold">__${g1}__</span>`);
  html = applyPattern(html,
    /(?<![\w*])\*([^*\n]+)\*(?![\w*])/g,
    (_, g1) => `<span class="input-hl-italic">*${g1}*</span>`);
  html = applyPattern(html,
    /(?<![\w_])_([^_\n]+)_(?![\w_])/g,
    (_, g1) => `<span class="input-hl-italic">_${g1}_</span>`);
  html = applyPattern(html,
    /(@[\w./\-]+|(?<![.\w])\/[\w./\-]+)/g,
    (m) => (m.startsWith('@') && !m.includes('/'))
      ? `<span class="input-hl-at">${m}</span>`
      : `<span class="input-hl-at input-hl-at-file">${m}</span>`);
  return html;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ALLOWED_TYPES = [...IMAGE_TYPES, 'application/pdf', 'text/plain', 'text/markdown'];
const MAX_ATTACHMENTS = 5;
const THUMB_MAX_PX = 200;
const THUMB_QUALITY = 0.7;

/** Generate a small JPEG thumbnail data URL from an image data URL. */
function generateThumbnail(dataUrl: string, maxSize = THUMB_MAX_PX): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', THUMB_QUALITY));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

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

// Shared BroadcastChannel for syncing mic state between main tab and sidepanel iframe
const MIC_CHANNEL = 'aigent-mic';

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

  // Set when running inside the Chrome extension sidepanel iframe
  const extId = useMemo(() => new URLSearchParams(window.location.search).get('extId'), []);
  const isSidepanel = !!extId;

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
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<number | null>(null);

  // Apply pending caret position synchronously after React renders the new value.
  // This avoids the race condition where setTimeout-based caret positioning
  // interleaves with subsequent keystrokes.
  useLayoutEffect(() => {
    if (pendingCaretRef.current !== null) {
      const pos = pendingCaretRef.current;
      pendingCaretRef.current = null;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    }
  });
  const micBaseTextRef = useRef('');
  const lastMicTextRef = useRef('');
  const [hasMicText, setHasMicText] = useState(false);
  const [micCapped, setMicCapped] = useState(false);

  const { stopAll: ttsStopAll } = useTTS();
  const micBroadcast = useRef<BroadcastChannel | null>(null);
  if (!micBroadcast.current) micBroadcast.current = new BroadcastChannel(MIC_CHANNEL);

  const { startMic, stopMic, abortMic, clearTranscript } = useMic(useCallback((text: string, windowCapped: boolean) => {
    lastMicTextRef.current = text;
    setHasMicText(!!text);
    setMicCapped(windowCapped);
    setInputValue(text);
    // Broadcast transcript to sidepanel (only from main tab)
    micBroadcast.current?.postMessage({ type: 'mic-transcript', text, windowCapped });
  }, []));

  useEffect(() => {
    registerScreenCapCallback(setScreenCapActive);
  }, []);

  // Main tab: broadcast mic state changes to the sidepanel
  useEffect(() => {
    if (isSidepanel) return;
    micBroadcast.current?.postMessage({ type: 'mic-state', micState, vadActive, micSticky });
  }, [isSidepanel, micState, vadActive, micSticky]);

  // Sidepanel: receive mic state + transcript from main tab; send commands back
  useEffect(() => {
    if (!isSidepanel) return;
    const ch = micBroadcast.current!;
    const handler = (e: MessageEvent<{ type: string; micState?: string; vadActive?: boolean; micSticky?: boolean; text?: string; windowCapped?: boolean }>) => {
      if (e.data.type === 'mic-state') {
        const { setMicState, setVadActive, setMicSticky: setStickyStore } = useVoiceStore.getState();
        if (e.data.micState) setMicState(e.data.micState as 'idle' | 'recording' | 'transcribing');
        if (e.data.vadActive !== undefined) setVadActive(e.data.vadActive);
        if (e.data.micSticky !== undefined) setStickyStore(e.data.micSticky);
      } else if (e.data.type === 'mic-transcript') {
        const text = e.data.text ?? '';
        lastMicTextRef.current = text;
        setHasMicText(!!text);
        setMicCapped(e.data.windowCapped ?? false);
        setInputValue(text);
      }
    };
    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }, [isSidepanel]);

  // Main tab: receive mic commands injected by the extension background via executeScript
  useEffect(() => {
    if (isSidepanel) return;
    const onStart = () => { void startMic(); };
    const onStop = () => { setMicSticky(false); void stopMic(); };
    const onStickyToggle = () => {
      const { micSticky: sticky, micState: state } = useVoiceStore.getState();
      const newSticky = !sticky;
      setMicSticky(newSticky);
      if (newSticky && state === 'idle') void startMic(false, inputRef.current?.value ?? '');
      else if (!newSticky && state === 'recording') void stopMic();
    };
    window.addEventListener('aigent-mic-activate', onStart);
    window.addEventListener('aigent-mic-stop', onStop);
    window.addEventListener('aigent-mic-sticky-toggle', onStickyToggle);
    return () => {
      window.removeEventListener('aigent-mic-activate', onStart);
      window.removeEventListener('aigent-mic-stop', onStop);
      window.removeEventListener('aigent-mic-sticky-toggle', onStickyToggle);
    };
  }, [isSidepanel, startMic, stopMic, setMicSticky]);

  // Test helper: reset local component state between shared-page tests
  useEffect(() => {
    const handler = () => {
      // Abort any running mic to clean up timers, in-flight requests, and refs
      // (the zustand store reset sets micState to 'idle' but doesn't stop the
      // actual mic infrastructure managed by useMic's refs)
      abortMic();
      setMicCapped(false);
      setHasMicText(false);
      setScreenCapActive(false);
      setPaletteHidden(false);
      setPaletteSelected(0);
      setAtTriggerPos(-1);
      setAtQuery('');
      setAtSelected(0);
    };
    window.addEventListener('__test_reset_input', handler);
    return () => window.removeEventListener('__test_reset_input', handler);
  }, [abortMic]);

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

  // Keep highlight overlay scroll in sync with textarea
  useEffect(() => {
    const el = inputRef.current;
    const hl = highlightRef.current;
    if (!el || !hl) return;
    const onScroll = () => { hl.scrollTop = el.scrollTop; };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

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

    // Handle /context locally — ContextInspector sends the request via its own effect
    if (text === '/context') {
      setCtxInspectorOpen(true);
      setInputValue('');
      return;
    }

    const msg: Record<string, unknown> = { type: 'message', content: text };
    if (pendingAttachments.length > 0) {
      msg.attachments = pendingAttachments.map(a => ({
        name: a.name, mediaType: a.mediaType, data: a.data,
        ...(a.thumbnail ? { thumbnail: a.thumbnail } : {}),
      }));
      clearAttachments();
    }
    if (useThinkingOverride) {
      msg.thinkingOverride = thinkingLevel === 'off' ? 'high' : 'off';
    }

    send(msg);
    setInputValue('');
    setMicCapped(false);
    setPaletteSelected(0);
    setAtTriggerPos(-1);
    setAtQuery('');
    setTimeout(() => inputRef.current?.focus(), 0);

    if (micSticky) setTimeout(() => { void startMic(true); }, 100);
  }, [
    inputValue, pendingAttachments, micState, thinkingLevel, micSticky,
    send, abortMic, clearAttachments, startMic, setCtxInspectorOpen,
  ]);

  // Demo mode: allow playback engine to control input via custom DOM events
  useEffect(() => {
    if (!isDemo()) return;
    const onSet = (e: Event) => {
      setInputValue((e as CustomEvent<string>).detail);
    };
    const onSubmit = () => {
      setTimeout(() => submitMessage(), 0);
    };
    window.addEventListener('__demo_set_input', onSet);
    window.addEventListener('__demo_submit_input', onSubmit);
    return () => {
      window.removeEventListener('__demo_set_input', onSet);
      window.removeEventListener('__demo_submit_input', onSubmit);
    };
  }, [submitMessage]);

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
      if (dataUrl) {
        generateThumbnail(dataUrl).then(thumb => {
          att.thumbnail = thumb;
          addAttachment(att);
        }).catch(() => addAttachment(att));
      } else {
        addAttachment(att);
      }
    };
    reader.readAsDataURL(file);
  }, [pendingAttachments.length, addAttachment]);

  const handleScreenCapToggle = useCallback(async () => {
    if (screenCapActive) {
      stopScreenShare();
      return;
    }
    try {
      await startScreenShare();
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError('Screen capture failed');
      }
    }
  }, [screenCapActive, setError]);

  const handleAttachScreenshot = useCallback(async () => {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) return;
    const base64 = captureScreenshot();
    if (!base64) return;
    const dataUrl = `data:image/png;base64,${base64}`;
    const att: PendingAttachment = {
      id: `att_${++attachIdCounter}`,
      name: 'screenshot.png',
      mediaType: 'image/png',
      data: base64,
      dataUrl,
      size: Math.round(base64.length * 0.75),
    };
    try {
      att.thumbnail = await generateThumbnail(dataUrl);
    } catch { /* proceed without thumbnail */ }
    addAttachment(att);
  }, [pendingAttachments.length, addAttachment]);

  // Send a mic command from the iframe to the sidepanel page via postMessage.
  // The sidepanel page (extension context) then forwards it to the background worker,
  // which uses executeScript — bypassing the user-gesture restriction on getUserMedia.
  const sendExtMicCmd = useCallback((type: string) => {
    if (isSidepanel) window.parent.postMessage({ type }, '*');
  }, [isSidepanel]);

  const toggleMicSticky = useCallback(() => {
    if (isSidepanel) { sendExtMicCmd('aigent-mic-sticky-toggle'); return; }
    const newSticky = !micSticky;
    setMicSticky(newSticky);
    if (newSticky && micState === 'idle') void startMic(false, inputRef.current?.value ?? '');
    else if (!newSticky && micState === 'recording') void stopMic();
  }, [isSidepanel, sendExtMicCmd, micSticky, micState, setMicSticky, startMic, stopMic]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(true);
      if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && e.ctrlKey) {
        e.preventDefault();
        const { shortcutsOpen, setShortcutsOpen } = useUIStore.getState();
        setShortcutsOpen(!shortcutsOpen);
        return;
      }
      if (e.code === 'Backquote' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        toggleMicSticky();
        return;
      }
      if (e.code === 'Backquote' && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (isSidepanel) { sendExtMicCmd(micState === 'recording' ? 'aigent-mic-stop' : 'aigent-mic-activate'); return; }
        if (micState === 'recording') { setMicSticky(false); void stopMic(); }
        else void startMic(false, inputRef.current?.value ?? '');
        return;
      }
      const active = document.activeElement;
      const anyInputFocused = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active instanceof HTMLSelectElement
        || (active as HTMLElement)?.isContentEditable;
      if (!anyInputFocused && (e.code === 'Backquote' || e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (isSidepanel) { sendExtMicCmd(micState === 'recording' ? 'aigent-mic-stop' : 'aigent-mic-activate'); return; }
        if (micState === 'recording') { setMicSticky(false); void stopMic(); }
        else void startMic(false, inputRef.current?.value ?? '');
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
      if (e.key === 'Enter') {
        e.preventDefault();
        const items = atItemsRef.current.length > 0 ? atItemsRef.current : getAtStaticMatches(atQuery);
        const clampedIdx = items.length > 0 ? Math.min(atSelected, items.length - 1) : 0;
        const item = items[clampedIdx] ?? items[0];
        if (item) handleAtComplete(item);
        return;
      }
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
    if (!item.argHint) {
      // Send directly with the completed value to avoid stale-closure issue
      // (submitMessage captures the pre-completion inputValue)
      send({ type: 'message', content: newVal });
      setInputValue('');
    }
    inputRef.current?.focus();
  };

  const handleAtComplete = (item: AtItem) => {
    const caret = inputRef.current?.selectionStart ?? inputValue.length;
    const token = item.insert;
    const newVal = inputValue.slice(0, atTriggerPos) + token + ' ' + inputValue.slice(caret);
    setInputValue(newVal);
    setAtTriggerPos(-1);
    setAtQuery('');
    setAtSelected(0);
    pendingCaretRef.current = atTriggerPos + token.length + 1;
    if (item.insert === '@screen') void startScreenShare().catch(() => { /* user can remove @screen manually */ });
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

        {/* Textarea with syntax highlight overlay */}
        <div id="input-wrap">
          <span id="mic-capped" className={micCapped ? '' : 'hidden'}>…</span>
          <div
            ref={highlightRef}
            id="input-highlight"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlightInputText(inputValue) }}
          />
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
        </div>

        {/* Attach button */}
        <button id="attach" title="Attach file" onClick={() => fileInputRef.current?.click()}>
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M15.5 10.5l-5.5 5.5a4 4 0 01-5.657-5.657l6.364-6.364a2.5 2.5 0 013.535 3.535l-6.364 6.364a1 1 0 01-1.414-1.414l5.657-5.657"/>
          </svg>
        </button>

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
              if (isSidepanel) { sendExtMicCmd(micState === 'recording' ? 'aigent-mic-stop' : 'aigent-mic-activate'); return; }
              if (micState === 'recording') { setMicSticky(false); void stopMic(); }
              else void startMic(false, inputRef.current?.value ?? '');
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
            className={[micSticky ? 'active' : '', micSticky && vadActive ? 'vad-active' : ''].filter(Boolean).join(' ')}
            title="Always-on mic"
            onClick={() => { toggleMicSticky(); inputRef.current?.focus(); }}
            style={{ fontSize: 18, lineHeight: 1 }}
          >
            ∞
          </button>

          <button
            id="mic-clear"
            className={micState === 'recording' && hasMicText ? '' : 'disabled'}
            disabled={!(micState === 'recording' && hasMicText)}
            title="Clear transcription"
            onClick={() => {
              clearTranscript();
              lastMicTextRef.current = '';
              setHasMicText(false);
              setMicCapped(false);
              setInputValue('');
            }}
          >
            ✕
          </button>
        </div>

        {/* Screen cap */}
        <div id="screen-cap-wrap" className={screenCapActive ? 'active' : ''}>
          <button
            id="screen-cap"
            className={screenCapActive ? 'active' : ''}
            title={screenCapActive ? 'Stop screen sharing' : 'Share screen'}
            onClick={() => void handleScreenCapToggle()}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="3" width="18" height="12" rx="2"/>
              <line x1="7" y1="19" x2="13" y2="19"/>
              <line x1="10" y1="15" x2="10" y2="19"/>
            </svg>
          </button>
          {screenCapActive && (
            <button
              id="screen-cap-snap"
              title="Attach screenshot"
              onClick={() => void handleAttachScreenshot()}
            >
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="10" cy="11" r="3"/>
                <path d="M7.5 4h5l1.5 2h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2L6.5 4z"/>
              </svg>
            </button>
          )}
        </div>

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
          <svg className={`icon-brain${willThink ? '' : ' hidden'}`} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
            <path d="M12 18v4"/>
          </svg>
          <svg className={`icon-arrow${willThink ? ' hidden' : ''}`} viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="10" y1="16" x2="10" y2="4"/>
            <polyline points="5,9 10,4 15,9"/>
          </svg>
        </button>

        <span id="hint-ctrl" style={{ display: 'none' }}>{currentlyOn ? 'quick' : 'think'}</span>
      </div>
    </div>
  );
}
