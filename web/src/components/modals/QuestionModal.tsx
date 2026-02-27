import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';

/**
 * Inline question form rendered inside InputArea (above the input row).
 * Replaces the input row when a user_question is at the front of the permQueue.
 */
export function QuestionForm() {
  const permQueue = useUIStore(s => s.permQueue);
  const resolveQuestionRequest = useUIStore(s => s.resolveQuestionRequest);
  const send = useConnectionStore(s => s.send);

  const req = permQueue[0];
  const isQuestion = req?.type === 'user_question';

  const [freeText, setFreeText] = useState('');
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());

  // Reset form state when question changes
  useEffect(() => {
    setFreeText('');
    setSelectedOptions(new Set());
  }, [req?.id]);

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
  const allowFreeText = req.questionAllowFreeText ?? (options.length === 0);
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
        <textarea
          className="question-freetext"
          placeholder={hasOptions ? 'Or type your own answer...' : 'Type your answer...'}
          value={freeText}
          onChange={(e) => {
            setFreeText(e.target.value);
            if (!multiSelect && selectedOptions.size > 0) {
              setSelectedOptions(new Set());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          rows={2}
          autoFocus={!hasOptions}
        />
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
