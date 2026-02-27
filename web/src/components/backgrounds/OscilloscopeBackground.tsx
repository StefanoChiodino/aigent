import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';
import { useVoiceStore } from '../../stores/voice';
import { initAudioAnalysis, getAudioFrame, destroyAudioAnalysis } from '../../hooks/useAudioAnalysis';

/**
 * Oscilloscope — CRT-style waveform line display.
 * Multiple overlapping waveforms with neon green glow, persistence trails,
 * and a phosphor afterglow effect.  Reacts to TTS audio waveform data.
 */

// Layer configuration: each waveform layer has its own visual character
const LAYERS = [
  { color: '0, 255, 70', alpha: 0.9, lineW: 2.5, phaseOff: 0, scale: 1.0, glow: 20 },
  { color: '0, 200, 120', alpha: 0.35, lineW: 1.5, phaseOff: 0.4, scale: 0.7, glow: 12 },
  { color: '60, 255, 120', alpha: 0.2, lineW: 1, phaseOff: -0.7, scale: 0.5, glow: 8 },
] as const;

export function OscilloscopeBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const animRef = useRef<number>(0);

  const isWorking = useUIStore(s => s.isLoading);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;

  const ttsPlaying = useVoiceStore(s => s.ttsPlaying);
  const ttsPlayingRef = useRef(ttsPlaying);
  ttsPlayingRef.current = ttsPlaying;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Offscreen canvas for persistence/trail effect
    const trail = document.createElement('canvas');
    trailRef.current = trail;
    const tCtx = trail.getContext('2d');
    if (!tCtx) return;

    initAudioAnalysis();

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + 'px';
      canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      trail.width = w * dpr;
      trail.height = h * dpr;
      tCtx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener('resize', resize);

    let phase = 0;

    function draw() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;
      const audio = getAudioFrame();

      // Persistence: fade the trail canvas slightly each frame
      const fadeAlpha = audio.isPlaying ? 0.15 : working ? 0.1 : 0.06;
      tCtx!.fillStyle = `rgba(0, 0, 0, ${fadeAlpha})`;
      tCtx!.fillRect(0, 0, w, h);

      phase += audio.isPlaying ? 0.03 : working ? 0.015 : 0.008;

      const centerY = h * 0.5;
      const amplitude = h * (audio.isPlaying ? 0.3 : working ? 0.15 : 0.08);
      const waveData = audio.waveformData;
      const binCount = waveData.length;

      // Draw each waveform layer onto the trail canvas
      for (const layer of LAYERS) {
        tCtx!.save();
        tCtx!.strokeStyle = `rgba(${layer.color}, ${layer.alpha})`;
        tCtx!.lineWidth = layer.lineW;
        tCtx!.shadowColor = `rgba(${layer.color}, 0.8)`;
        tCtx!.shadowBlur = layer.glow;
        tCtx!.lineJoin = 'round';
        tCtx!.lineCap = 'round';

        tCtx!.beginPath();

        const points: Array<[number, number]> = [];
        const step = w / (binCount - 1);

        for (let i = 0; i < binCount; i++) {
          // Waveform centered at 128, map to -1..1
          const raw = (waveData[i] - 128) / 128;
          // Add layer offset with subtle phase shift
          const offset = Math.sin(phase * 2 + i * 0.05 + layer.phaseOff) * 0.05;
          const y = centerY + (raw * layer.scale + offset) * amplitude;
          points.push([i * step, y]);
        }

        // Draw smooth bezier curve through points
        if (points.length > 2) {
          tCtx!.moveTo(points[0][0], points[0][1]);
          for (let i = 1; i < points.length - 1; i++) {
            const xc = (points[i][0] + points[i + 1][0]) / 2;
            const yc = (points[i][1] + points[i + 1][1]) / 2;
            tCtx!.quadraticCurveTo(points[i][0], points[i][1], xc, yc);
          }
          const last = points[points.length - 1];
          tCtx!.lineTo(last[0], last[1]);
        }

        tCtx!.stroke();
        tCtx!.restore();
      }

      // Draw grid lines (subtle CRT effect)
      ctx!.clearRect(0, 0, w, h);

      // Scanline grid
      const gridAlpha = audio.isPlaying ? 0.06 : working ? 0.04 : 0.025;
      ctx!.strokeStyle = `rgba(0, 255, 70, ${gridAlpha})`;
      ctx!.lineWidth = 0.5;

      // Horizontal grid lines
      const gridSpacing = 60;
      for (let y = gridSpacing; y < h; y += gridSpacing) {
        ctx!.beginPath();
        ctx!.moveTo(0, y);
        ctx!.lineTo(w, y);
        ctx!.stroke();
      }
      // Vertical grid lines
      for (let x = gridSpacing; x < w; x += gridSpacing) {
        ctx!.beginPath();
        ctx!.moveTo(x, 0);
        ctx!.lineTo(x, h);
        ctx!.stroke();
      }

      // Center line (brighter)
      ctx!.strokeStyle = `rgba(0, 255, 70, ${gridAlpha * 2.5})`;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(0, centerY);
      ctx!.lineTo(w, centerY);
      ctx!.stroke();

      // Composite the trail canvas onto the main canvas
      ctx!.drawImage(trail, 0, 0, w, h);

      // Vignette overlay
      const vGrad = ctx!.createRadialGradient(w / 2, h / 2, w * 0.25, w / 2, h / 2, w * 0.75);
      vGrad.addColorStop(0, 'rgba(0,0,0,0)');
      vGrad.addColorStop(1, 'rgba(0,0,0,0.4)');
      ctx!.fillStyle = vGrad;
      ctx!.fillRect(0, 0, w, h);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animRef.current);
      destroyAudioAnalysis();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="theme-canvas-bg"
      aria-hidden="true"
    />
  );
}
