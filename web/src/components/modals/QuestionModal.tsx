import React, { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';
import { useVoiceStore } from '../../stores/voice';
import type { MicControls } from '../../hooks/useMic';

export interface QuestionFormProps {
  /** Mic controls from InputArea's single useMic instance */
  micControls: MicControls;
  /** Called when the question textarea gains focus — routes STT here */
  onSttFocus: () => void;
  /** Ref for InputArea to push transcription text into QuestionForm */
  questionSttRef: React.MutableRefObject<QuestionSttApi | null>;
}

export interface QuestionSttApi {
  /** State updater for freeText (same signature as React setState) */
  set: (updater: (prev: string) => string) => void;
  /** Last STT value for suffix-preservation logic */
  lastSttValue: string;
}

/**
 * Inline question form rendered inside InputArea (above the input row).
 * Replaces the input row when a user_question is at the front of the permQueue.
 */
export function QuestionForm({ micControls, onSttFocus, questionSttRef }: QuestionFormProps) {
  const permQueue = useUIStore(s => s.permQueue);
  const resolveQuestionRequest = useUIStore(s => s.resolveQuestionRequest);
  const send = useConnectionStore(s => s.send);
  const micState = useVoiceStore(s => s.micState);
  const vadActive = useVoiceStore(s => s.vadActive);

  const req = permQueue[0];
  const isQuestion = req?.type === 'user_question';

  const [freeText, setFreeText] = useState('');
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Register the setter so InputArea's onTranscript can push text here
  useEffect(() => {
    if (isQuestion) {
      questionSttRef.current = {
        set: setFreeText,
        lastSttValue: '',
      };
    }
    return () => { questionSttRef.current = null; };
  }, [isQuestion, questionSttRef]);

  // Reset form state when question changes
  useEffect(() => {
    setFreeText('');
    setSelectedOptions(new Set());
    if (questionSttRef.current) questionSttRef.current.lastSttValue = '';
  }, [req?.id, questionSttRef]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isQuestion || !req) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
      } else if (e.key === 'Enter' && tag !== 'TEXTAREA' && tag !== 'INPUT') {
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  if (!isQuestion || !req) return null;

  const options = req.questionOptions ?? [];
  const multiSelect = req.questionMultiSelect ?? false;
  const allowFreeText = true;
  const hasOptions = options.length > 0;

  const canSubmit = (hasOptions && selectedOptions.size > 0) ||
    (allowFreeText && freeText.trim().length > 0);

  function handleSubmit() {
    if (!canSubmit) return;
    const selArr = selectedOptions.size > 0 ? Array.from(selectedOptions) : undefined;
    const answer = freeText.trim() || (selArr ? selArr.join(', ') : '');
    resolveQuestionRequest(send, answer, selArr, false);
  }

  function handleDismiss() {
    resolveQuestionRequest(send, '', undefined, true);
  }

  function toggleOption(label: string) {
    if (multiSelect) {
      setSelectedOptions(prev => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label); else next.add(label);
        return next;
      });
    } else {
      setSelectedOptions(new Set([label]));
      if (allowFreeText) setFreeText('');
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setFreeText(val);
    if (!multiSelect && selectedOptions.size > 0) {
      setSelectedOptions(new Set());
    }
    if (micState === 'recording') {
      micControls.commitBase(val);
      if (questionSttRef.current) questionSttRef.current.lastSttValue = val;
    }
  }

  function handleMicClick() {
    // Mark question as STT target before starting
    onSttFocus();
    if (micState === 'recording') {
      void micControls.stopMic();
    } else {
      void micControls.startMic(false, textareaRef.current?.value ?? '');
    }
    textareaRef.current?.focus();
  }

  return (
    <div id="question-inline">
      <div className="question-header">
        <span className="question-icon">&#x2753;</span>
        <span className="question-title">Question from Agent</span>
      </div>
      <div className="question-text">{req.detail}</div>

      {hasOptions && (
        <div className="question-options">
          {options.map((opt) => (
            <label
              key={opt.label}
              className={`question-option${selectedOptions.has(opt.label) ? ' selected' : ''}`}
            >
              <input
                type={multiSelect ? 'checkbox' : 'radio'}
                name="question-option"
                checked={selectedOptions.has(opt.label)}
                onChange={() => toggleOption(opt.label)}
              />
              <div className="question-option-content">
                <div className="question-option-label">{opt.label}</div>
                {opt.description && (
                  <div className="question-option-desc">{opt.description}</div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {allowFreeText && (
        <div className="question-input-row">
          <textarea
            ref={textareaRef}
            className="question-freetext"
            placeholder={
              micState === 'recording' ? 'Listening…' :
              hasOptions ? 'Or type your own answer...' : 'Type your answer...'
            }
            value={freeText}
            onChange={handleTextareaChange}
            onFocus={onSttFocus}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (micState === 'recording') {
                  void micControls.stopMic().then(() => handleSubmit());
                } else {
                  handleSubmit();
                }
              }
            }}
            rows={2}
            autoFocus={!hasOptions}
          />
          <button
            className={[
              'question-mic',
              micState === 'recording' ? 'recording' : '',
              micState === 'transcribing' ? 'transcribing' : '',
              vadActive ? 'vad-active' : '',
            ].filter(Boolean).join(' ')}
            title={micState === 'recording' ? 'Stop mic' : 'Start mic'}
            onClick={handleMicClick}
            type="button"
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
        </div>
      )}

      <div className="question-actions">
        <button
          className="perm-btn perm-approve"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          Submit
        </button>
        <button
          className="perm-btn perm-deny"
          onClick={handleDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
