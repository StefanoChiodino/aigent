import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useConnectionStore } from '../stores/connection';
import { isDemo } from '../demo/useDemoMode';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { QuestionForm } from './modals/QuestionModal';
import { useMic } from '../hooks/useMic';
import { useTTS } from '../hooks/useTTS';
import { captureScreenshot, registerScreenCapCallback, startScreenShare, stopScreenShare } from '../lib/screen';
import { COMMANDS } from '../lib/settings-schema';
import { useSettingsStore } from '../stores/settings';
import { getActiveBindings, matchesAction, matchesBinding } from '../lib/keybindings.js';
import { CommandPalette } from './CommandPalette';
import { AtPalette, getAtStaticMatches } from './AtPalette';
import { AttachmentPreview } from './AttachmentPreview';
import { QueueChips } from './QueueChips';
import { broadcastSync, onSyncMessage } from '../lib/broadcastSync';
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

export function InputArea() {
  const send = useConnectionStore(s => s.send);
  const isLoading = useUIStore(s => s.isLoading);
  const errorMsg = useUIStore(s => s.errorMsg);
  const setError = useUIStore(s => s.setError);
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

  const [inputValue, setInputValue] = useState(
    () => sessionStorage.getItem('aigent-draft') ?? '',
  );
  const [paletteSelected, setPaletteSelected] = useState(0);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [atTriggerPos, setAtTriggerPos] = useState(-1);
  const [atQuery, setAtQuery] = useState('');
  const [atSelected, setAtSelected] = useState(0);
  const atItemsRef = useRef<AtItem[]>([]);
  const [screenCapActive, setScreenCapActive] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const multilineEnter = useSettingsStore(s => s.getClientSetting('AIGENT_MULTILINE_ENTER')) === true;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  // Prevents echo when receiving our own broadcast (we set this true when
  // applying a remote update so the resulting setInputValue doesn't re-broadcast).
  const suppressBroadcastRef = useRef(false);

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

  // BroadcastChannel sync: receive input-text / input-clear / mic-state from the other window.
  useEffect(() => {
    return onSyncMessage((msg) => {
      if (msg.type === 'input-text') {
        suppressBroadcastRef.current = true;
        setInputValue(msg.text);
        suppressBroadcastRef.current = false;
      } else if (msg.type === 'input-clear') {
        suppressBroadcastRef.current = true;
        setInputValue('');
        suppressBroadcastRef.current = false;
      } else if (msg.type === 'mic-state') {
        // Reflect the other window's mic activity in this window's voice store
        // (visual indicator only — don't actually start/stop the mic here).
        const store = useVoiceStore.getState();
        store.setMicState(msg.active ? 'recording' : 'idle');
      }
    });
  }, []);

  // Broadcast our mic state changes so the other window can reflect them.
  useEffect(() => {
    broadcastSync({ type: 'mic-state', active: micState === 'recording' });
  }, [micState]);

  const micBaseTextRef = useRef('');
  const lastMicTextRef = useRef('');
  const lastSttValueRef = useRef('');
  /** Timer ID for hold-to-cancel (hold:Escape). Cleared on keyup/blur. */
  const holdCancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasMicText, setHasMicText] = useState(false);
  const [micCapped, setMicCapped] = useState(false);

  const { stopAll: ttsStopAll } = useTTS();

  const { startMic, stopMic, abortMic, clearTranscript, commitBase } = useMic(useCallback((text: string, windowCapped: boolean) => {
    lastMicTextRef.current = text;
    setHasMicText(!!text);
    setMicCapped(windowCapped);
    setInputValue(prev => {
      const oldStt = lastSttValueRef.current;
      // If user appended text after the last STT value, preserve that suffix
      const suffix = oldStt && prev.startsWith(oldStt) ? prev.slice(oldStt.length) : '';
      lastSttValueRef.current = text;
      return text + suffix;
    });
  }, []));

  useEffect(() => {
    registerScreenCapCallback(setScreenCapActive);
  }, []);

  // Auto-start mic on mount if micSticky was persisted as true (e.g. in the PiP iframe).
  useEffect(() => {
    if (micSticky) {
      void startMic(true);
    }
    // Only run on initial mount — intentionally omit micSticky/startMic from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Test helper: reset local component state between shared-page tests
  useEffect(() => {
    const handler = () => {
      // Abort any running mic to clean up timers, in-flight requests, and refs
      // (the zustand store reset sets micState to 'idle' but doesn't stop the
      // actual mic infrastructure managed by useMic's refs)
      abortMic();
      lastSttValueRef.current = '';
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

  // Persist draft to sessionStorage so it survives page reloads
  useEffect(() => {
    if (inputValue) sessionStorage.setItem('aigent-draft', inputValue);
    else sessionStorage.removeItem('aigent-draft');
  }, [inputValue]);

  // Auto-grow textarea and keep bottom visible
  const autoGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    el.scrollTop = el.scrollHeight;
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
      setAtQuery(text.slice(trigPos + 1, caret));
    }
  }, []);

  const submitMessage = useCallback((useThinkingOverride = false) => {
    if (micState === 'recording') abortMic();
    const text = inputValue.trim();
    if (!text && pendingAttachments.length === 0) {
      // Nothing to send — but if sticky mode is on, restart the mic
      if (micSticky) setTimeout(() => { void startMic(true); }, 100);
      return;
    }

    // Handle /context locally — ContextInspector sends the request via its own effect
    if (text === '/context') {
      setCtxInspectorOpen(true);
      setInputValue('');
      return;
    }

    const reqId = Math.random().toString(16).slice(2, 8);
    const msg: Record<string, unknown> = { type: 'message', content: text, reqId };
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

    if (!send(msg)) {
      setError('Not connected — message not sent');
      return;
    }
    broadcastSync({ type: 'input-clear' });
    setInputValue('');
    lastSttValueRef.current = '';
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

  // Pull a queued message back into the input box for editing.
  // Guard: only works when the input is empty so we don't silently discard a draft.
  const handlePullBack = useCallback((text: string, id: number) => {
    if (inputValue.trim()) return; // input box has content — ignore
    setInputValue(text);
    broadcastSync({ type: 'input-text', text });
    send({ type: 'cancel_queued', id });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [inputValue, send]);

  // Demo mode: allow playback engine to control input via custom DOM events
  useEffect(() => {
    if (!isDemo()) return;
    const onSet = (e: Event) => {
      const val = (e as CustomEvent<string>).detail;
      setInputValue(val);
      computeAtTrigger(val, val.length);
      setPaletteHidden(false);
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

  const toggleMicSticky = useCallback(() => {
    const newSticky = !micSticky;
    setMicSticky(newSticky);
    if (newSticky && micState === 'idle') void startMic(false, inputRef.current?.value ?? '');
    else if (!newSticky && micState === 'recording') void stopMic();
  }, [micSticky, micState, setMicSticky, startMic, stopMic]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(true);
      if (e.key === 'Shift') setShiftHeld(true);

      const active = document.activeElement;
      const anyInputFocused = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active instanceof HTMLSelectElement
        || (active as HTMLElement)?.isContentEditable;
      const noInputFocused = !anyInputFocused;

      const bindings = getActiveBindings();

      if (matchesAction(e, 'showShortcuts', bindings, { noInputFocused })) {
        e.preventDefault();
        const { shortcutsOpen, setShortcutsOpen } = useUIStore.getState();
        setShortcutsOpen(!shortcutsOpen);
        return;
      }
      if (matchesAction(e, 'toggleMicSticky', bindings, { noInputFocused })) {
        e.preventDefault();
        toggleMicSticky();
        return;
      }
      if (matchesAction(e, 'toggleMic', bindings, { noInputFocused })) {
        e.preventDefault();
        if (micState === 'recording') { setMicSticky(false); void stopMic(); }
        else void startMic(false, inputRef.current?.value ?? '');
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false);
      if (e.key === 'Shift') setShiftHeld(false);
    };
    const onBlur = () => { setCtrlHeld(false); setShiftHeld(false); };
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
  const overrideHeld = multilineEnter ? shiftHeld : ctrlHeld;
  const willThink = overrideHeld ? !currentlyOn : currentlyOn;

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
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const item = paletteItems[paletteSelected];
        if (item) handlePaletteComplete(item);
        return;
      }
    }
    // --- Enter key behaviour (depends on multilineEnter setting) ---
    if (e.key === 'Enter') {
      const isSend = multilineEnter
        ? e.ctrlKey && !e.shiftKey        // Ctrl+Enter sends
        : !e.shiftKey && !e.ctrlKey;      // plain Enter sends
      const isThinkingOverride = multilineEnter
        ? e.shiftKey && !e.ctrlKey        // Shift+Enter = thinking toggle
        : e.ctrlKey && !e.shiftKey;       // Ctrl+Enter = thinking toggle

      // While dictating: send-key stops mic and sends
      if (micState === 'recording' && isSend) {
        e.preventDefault();
        void stopMic().then(() => submitMessage());
        return;
      }
      // Thinking override
      if (isThinkingOverride) {
        e.preventDefault();
        submitMessage(true);
        return;
      }
      // Send
      if (isSend) {
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
      // Auto-list continuation: if current line starts with a list marker, continue it
      if (!isSend && !isThinkingOverride) {
        const ta = inputRef.current;
        const caret = ta?.selectionStart ?? inputValue.length;
        const lineStart = inputValue.lastIndexOf('\n', caret - 1) + 1;
        const line = inputValue.slice(lineStart, caret);
        const listMatch = line.match(/^(\s*)([-*])\s+(.*)$/) ?? line.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (listMatch) {
          e.preventDefault();
          const indent = listMatch[1]!;
          const marker = listMatch[2]!;
          const content = listMatch[3]!;
          if (!content) {
            // Empty list item — exit list by removing the prefix
            const newVal = inputValue.slice(0, lineStart) + inputValue.slice(caret);
            setInputValue(newVal);
            pendingCaretRef.current = lineStart;
          } else {
            const nextMarker = /^\d+$/.test(marker) ? String(parseInt(marker) + 1) + '.' : marker + ' ';
            const prefix = indent + nextMarker + (nextMarker.endsWith('.') ? ' ' : '');
            const newVal = inputValue.slice(0, caret) + '\n' + prefix + inputValue.slice(caret);
            setInputValue(newVal);
            pendingCaretRef.current = caret + 1 + prefix.length;
          }
          return;
        }
      }
      // Otherwise: let the browser insert the newline (Shift+Enter in normal, plain Enter in multiline)
    }
    const bindings = getActiveBindings();
    // cancelResponse — stop an in-progress response.
    // Supports two modes:
    //   • hold binding (e.g. hold:Escape): start a timer on keydown; if the key
    //     is released before the timer fires, the action is cancelled. This lets
    //     plain Escape still fall through to clearInput.
    //   • immediate binding (e.g. Ctrl+Escape): fire right away as before.
    if (isLoading) {
      const cancelBindings = bindings.cancelResponse ?? [];
      for (const cb of cancelBindings) {
        if (!matchesBinding(e.nativeEvent, cb)) continue;
        if (cb.hold !== undefined) {
          // Hold binding: start a timer; keyup/blur will clear it
          if (holdCancelTimerRef.current === null) {
            holdCancelTimerRef.current = setTimeout(() => {
              holdCancelTimerRef.current = null;
              send({ type: 'cancel' });
            }, cb.hold);
          }
          // Don't preventDefault here — allow Escape to propagate so the
          // browser can close any overlays, but we'll cancel on hold.
          return;
        } else {
          // Immediate binding: fire now
          e.preventDefault();
          send({ type: 'cancel' });
          return;
        }
      }
    }
    // clearInput — Escape (or user-configured key), but only when nothing
    // higher-priority is consuming Escape (palettes, cancelResponse).
    if (matchesAction(e.nativeEvent, 'clearInput', bindings)) {
      if (paletteItems.length > 0 && !paletteHidden) {
        // First Escape: hide palette but keep text
        setPaletteHidden(true);
        setPaletteSelected(0);
      } else if (inputValue) {
        // Clear the input — mirror the ✕ button logic
        e.preventDefault();
        if (micState === 'recording') {
          clearTranscript();
          lastMicTextRef.current = '';
          lastSttValueRef.current = '';
          setHasMicText(false);
          setMicCapped(false);
        }
        lastSttValueRef.current = '';
        setInputValue('');
        broadcastSync({ type: 'input-clear' });
        setPaletteHidden(false);
        inputRef.current?.focus();
      }
    }
  };

  /** Cancel any pending hold-to-cancel timer when the key is released. */
  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (holdCancelTimerRef.current !== null && e.code === 'Escape') {
      clearTimeout(holdCancelTimerRef.current);
      holdCancelTimerRef.current = null;
    }
  };

  /** Also clear the hold timer if the textarea loses focus mid-hold. */
  const handleBlur = () => {
    if (holdCancelTimerRef.current !== null) {
      clearTimeout(holdCancelTimerRef.current);
      holdCancelTimerRef.current = null;
    }
  };

  const handlePaletteComplete = (item: CommandDef) => {
    const newVal = item.argHint ? item.name + ' ' : item.name;
    setInputValue(newVal);
    setPaletteSelected(0);
    if (!item.argHint) {
      // Send directly with the completed value to avoid stale-closure issue
      // (submitMessage captures the pre-completion inputValue)
      if (!send({ type: 'message', content: newVal })) {
        setError('Not connected — message not sent');
        return;
      }
      setInputValue('');
    }
    inputRef.current?.focus();
  };

  const handleAtComplete = (item: AtItem) => {
    const caret = inputRef.current?.selectionStart ?? inputValue.length;

    if (item.isDir) {
      // Directory navigation — keep palette open, update query to new dir path
      const dirPath = item.insert; // e.g. "~/Documents/"
      const newVal = inputValue.slice(0, atTriggerPos) + '@' + dirPath + inputValue.slice(caret);
      setInputValue(newVal);
      // Don't reset atTriggerPos — palette stays open
      setAtQuery(dirPath);
      setAtSelected(0);
      pendingCaretRef.current = atTriggerPos + 1 + dirPath.length; // +1 for @
      return;
    }

    // File or static item — close palette, insert token
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
    if (!suppressBroadcastRef.current) {
      broadcastSync({ type: 'input-text', text: val });
    }
    const caret = e.target.selectionStart ?? val.length;
    computeAtTrigger(val, caret);
    setPaletteSelected(0);
    setPaletteHidden(false);
    // When user edits during recording, adopt their text as the new base.
    // This clears stale audio samples so STT appends after the user's text.
    if (micState === 'recording') {
      commitBase(val);
      lastSttValueRef.current = val;
    }
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
      <QueueChips onPullBack={handlePullBack} />

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
        selected={atSelected}
        onSelect={setAtSelected}
        onComplete={handleAtComplete}
        onItemsChange={useCallback((items: AtItem[]) => { atItemsRef.current = items; }, [])}
      />

      <QuestionForm />

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
            onKeyUp={handleKeyUp}
            onBlur={handleBlur}
            onPaste={handlePaste}
            autoFocus
          />
          {inputValue && (
            <button
              id="input-clear"
              title="Clear input"
              onClick={() => {
                if (micState === 'recording') {
                  clearTranscript();
                  lastMicTextRef.current = '';
                  lastSttValueRef.current = '';
                  setHasMicText(false);
                  setMicCapped(false);
                }
                lastSttValueRef.current = '';
                setInputValue('');
                inputRef.current?.focus();
              }}
            >
              ✕
            </button>
          )}
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
              if (isDemo()) {
                // Demo mode: toggle visual state without accessing real mic hardware
                const vs = useVoiceStore.getState();
                vs.setMicState(vs.micState === 'idle' ? 'recording' : 'idle');
                return;
              }
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

        {/* Cancel (visible when busy) + Send (always visible) — side by side */}
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
          className={overrideHeld ? 'thinking-override' : ''}
          title={overrideHeld ? (currentlyOn ? 'Send without thinking' : 'Send with thinking') : (showCancel ? 'Queue message' : 'Send')}
          onClick={() => submitMessage(overrideHeld)}
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
