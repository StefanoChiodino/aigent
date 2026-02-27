import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDemoPlaybackStore } from './demoStore';
import { getDemoEngine } from './useDemoMode';

export const DemoScrubber = React.memo(function DemoScrubber() {
  const currentStep = useDemoPlaybackStore(s => s.currentStep);
  const totalSteps = useDemoPlaybackStore(s => s.totalSteps);
  const playing = useDemoPlaybackStore(s => s.playing);
  const stepLabels = useDemoPlaybackStore(s => s.stepLabels);
  const sections = useDemoPlaybackStore(s => s.sections);
  const currentSectionId = useDemoPlaybackStore(s => s.currentSectionId);

  // Current label with fade transition
  const currentLabel = stepLabels[currentStep] || '';
  const [displayLabel, setDisplayLabel] = useState(currentLabel);
  const [labelVisible, setLabelVisible] = useState(!!currentLabel);
  const fadeTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (currentLabel === displayLabel) return;
    // Fade out, swap text, fade in
    setLabelVisible(false);
    clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => {
      setDisplayLabel(currentLabel);
      setLabelVisible(!!currentLabel);
    }, 300); // matches CSS transition duration
    return () => clearTimeout(fadeTimer.current);
  }, [currentLabel, displayLabel]);

  // Tooltip state for slider hover
  const [hoverLabel, setHoverLabel] = useState('');
  const [hoverX, setHoverX] = useState(0);
  const [showTooltip, setShowTooltip] = useState(false);
  const sliderRef = useRef<HTMLInputElement>(null);

  const onSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const engine = getDemoEngine();
    if (!engine) return;
    engine.seekTo(Number(e.target.value));
  }, []);

  const onSliderHover = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    const slider = sliderRef.current;
    if (!slider || totalSteps === 0) return;
    const rect = slider.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const step = Math.round(ratio * totalSteps);
    const label = stepLabels[Math.max(0, Math.min(step, stepLabels.length - 1))];
    if (label) {
      setHoverLabel(label);
      setHoverX(e.clientX - rect.left);
      setShowTooltip(true);
    } else {
      setShowTooltip(false);
    }
  }, [totalSteps, stepLabels]);

  const togglePlay = useCallback(() => {
    const engine = getDemoEngine();
    if (!engine) return;
    engine.togglePause();
  }, []);

  const onSectionClick = useCallback((id: string) => {
    const engine = getDemoEngine();
    if (!engine) return;
    engine.seekToSection(id);
    engine.resume();
  }, []);

  if (totalSteps === 0) return null;

  return (
    <div id="demo-scrubber">
      {sections.length > 0 && (
        <div className="demo-sections">
          {sections.map(s => (
            <button
              key={s.id}
              className={`demo-section-pill${s.id === currentSectionId ? ' active' : ''}`}
              onClick={() => onSectionClick(s.id)}
              title={`Jump to: ${s.label}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="demo-scrub-controls">
        <button className="demo-scrub-btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
          {playing ? (
            <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
              <rect x="4" y="3" width="4" height="14" rx="1" />
              <rect x="12" y="3" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
              <path d="M5 3l12 7-12 7z" />
            </svg>
          )}
        </button>
        <div className="demo-scrub-slider-wrap">
          <input
            ref={sliderRef}
            type="range"
            className="demo-scrub-slider"
            min={0}
            max={totalSteps}
            value={currentStep}
            onChange={onSliderChange}
            onMouseMove={onSliderHover}
            onMouseLeave={() => setShowTooltip(false)}
          />
          {showTooltip && (
            <div
              className="demo-scrub-tooltip"
              style={{ left: `${hoverX}px` }}
            >
              {hoverLabel}
            </div>
          )}
        </div>
        <span
          className={`demo-scrub-label ${labelVisible ? 'visible' : ''}`}
        >
          {displayLabel}
        </span>
        <span className="demo-scrub-counter">{currentStep} / {totalSteps}</span>
      </div>
    </div>
  );
});
