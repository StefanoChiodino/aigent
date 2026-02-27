import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';
import { useVoiceStore } from '../../stores/voice';
import { initAudioAnalysis, getAudioFrame, destroyAudioAnalysis } from '../../hooks/useAudioAnalysis';

/**
 * Spectrum — full-screen Winamp-style frequency bar visualizer.
 * Bottom-anchored bars with segmented blocks, green→yellow→red gradient,
 * falling peak indicators, mirrored reflection, and radial glow.
 * Reacts to TTS audio; shows ambient breathing bars when idle.
 */

const BAR_COUNT = 56;
const BAR_GAP = 3;
const SEG_HEIGHT = 4;
const SEG_GAP = 1;

// Winamp gradient stops
const GRADIENT_STOPS = [
  { at: 0, r: 40, g: 200, b: 80 },     // green
  { at: 0.5, r: 220, g: 220, b: 40 },   // yellow
  { at: 0.85, r: 220, g: 50, b: 30 },    // red
  { at: 1.0, r: 255, g: 255, b: 255 },   // white (peak)
] as const;

function barColor(frac: number): string {
  for (let i = GRADIENT_STOPS.length - 1; i >= 0; i--) {
    if (frac >= GRADIENT_STOPS[i].at) {
      const s = GRADIENT_STOPS[i];
      return `rgb(${s.r},${s.g},${s.b})`;
    }
  }
  const s = GRADIENT_STOPS[0];
  return `rgb(${s.r},${s.g},${s.b})`;
}

function barColorRGB(frac: number): [number, number, number] {
  for (let i = GRADIENT_STOPS.length - 1; i >= 0; i--) {
    if (frac >= GRADIENT_STOPS[i].at) {
      return [GRADIENT_STOPS[i].r, GRADIENT_STOPS[i].g, GRADIENT_STOPS[i].b];
    }
  }
  return [GRADIENT_STOPS[0].r, GRADIENT_STOPS[0].g, GRADIENT_STOPS[0].b];
}

export function SpectrumBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const smoothedRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const peaksRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const peakVelRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));

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

    initAudioAnalysis();

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = window.innerWidth * dpr;
      canvas!.height = window.innerHeight * dpr;
      canvas!.style.width = window.innerWidth + 'px';
      canvas!.style.height = window.innerHeight + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener('resize', resize);

    const smoothed = smoothedRef.current;
    const peaks = peaksRef.current;
    const peakVel = peakVelRef.current;

    function draw() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;
      const audio = getAudioFrame();

      ctx!.clearRect(0, 0, w, h);

      // Map frequency bins to bars
      const binCount = audio.frequencyData.length;
      const binsPerBar = Math.max(1, Math.floor(binCount / BAR_COUNT));
      const maxBarH = h * 0.45; // bars fill up to 45% of viewport

      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        const start = Math.floor(i * binCount / BAR_COUNT);
        const end = Math.min(start + binsPerBar, binCount);
        for (let j = start; j < end; j++) sum += audio.frequencyData[j];
        const raw = (sum / (end - start)) / 255;
        const target = raw * maxBarH;
        // Smooth: rise fast, fall slow
        smoothed[i] = target > smoothed[i]
          ? smoothed[i] * 0.3 + target * 0.7
          : smoothed[i] * 0.92 + target * 0.08;
      }

      // Update peaks
      for (let i = 0; i < BAR_COUNT; i++) {
        if (smoothed[i] > peaks[i]) {
          peaks[i] = smoothed[i];
          peakVel[i] = 0;
        } else {
          peakVel[i] += 0.15;
          peaks[i] -= peakVel[i];
          if (peaks[i] < 0) peaks[i] = 0;
        }
      }

      const totalBarWidth = (w - (BAR_COUNT - 1) * BAR_GAP);
      const barW = totalBarWidth / BAR_COUNT;
      const baseY = h * 0.62; // bars grow upward from here

      // Glow intensity
      const glowAlpha = audio.isPlaying ? 0.5 : working ? 0.3 : 0.15;

      for (let i = 0; i < BAR_COUNT; i++) {
        const x = i * (barW + BAR_GAP);
        const barH = Math.max(1, smoothed[i]);
        const segTotal = Math.ceil(barH / (SEG_HEIGHT + SEG_GAP));

        // Background glow per bar
        const peakFrac = barH / maxBarH;
        const [gr, gg, gb] = barColorRGB(peakFrac);
        const glowH = barH + 20;
        const grad = ctx!.createRadialGradient(
          x + barW / 2, baseY, 0,
          x + barW / 2, baseY, glowH * 0.7,
        );
        grad.addColorStop(0, `rgba(${gr},${gg},${gb},${glowAlpha * 0.4})`);
        grad.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
        ctx!.fillStyle = grad;
        ctx!.fillRect(x - 10, baseY - glowH, barW + 20, glowH + 10);

        // Draw segmented bar blocks
        for (let s = 0; s < segTotal; s++) {
          const segY = baseY - (s + 1) * (SEG_HEIGHT + SEG_GAP);
          const frac = (s + 1) / (maxBarH / (SEG_HEIGHT + SEG_GAP));
          ctx!.fillStyle = barColor(frac);
          ctx!.globalAlpha = 0.9;
          ctx!.fillRect(x, segY, barW, SEG_HEIGHT);
        }

        // Reflection (mirrored, fading)
        for (let s = 0; s < Math.min(segTotal, 8); s++) {
          const segY = baseY + 4 + s * (SEG_HEIGHT + SEG_GAP);
          const frac = (segTotal - s) / (maxBarH / (SEG_HEIGHT + SEG_GAP));
          ctx!.fillStyle = barColor(frac);
          ctx!.globalAlpha = 0.12 - s * 0.012;
          ctx!.fillRect(x, segY, barW, SEG_HEIGHT);
        }

        ctx!.globalAlpha = 1;

        // Peak indicator
        if (peaks[i] > 3) {
          const peakY = baseY - peaks[i];
          const pFrac = peaks[i] / maxBarH;
          ctx!.fillStyle = barColor(pFrac);
          ctx!.globalAlpha = 0.95;
          ctx!.fillRect(x, peakY, barW, 2);
          ctx!.globalAlpha = 1;
        }
      }

      // Horizontal glow line at base
      const lineGrad = ctx!.createLinearGradient(0, baseY - 2, 0, baseY + 6);
      lineGrad.addColorStop(0, `rgba(40, 200, 80, ${glowAlpha * 0.3})`);
      lineGrad.addColorStop(1, 'rgba(40, 200, 80, 0)');
      ctx!.fillStyle = lineGrad;
      ctx!.fillRect(0, baseY - 1, w, 8);

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
