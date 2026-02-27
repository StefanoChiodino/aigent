import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';
import { useVoiceStore } from '../../stores/voice';
import { initAudioAnalysis, getAudioFrame, destroyAudioAnalysis } from '../../hooks/useAudioAnalysis';

/**
 * Circular Spectrum — radial frequency bars arranged in a circle.
 * Bars radiate outward from a central ring with HSL color rotation,
 * mirrored inner/outer bars, pulsing center, and slow rotation.
 * Reacts to TTS audio; gentle pulsing when idle.
 */

const NUM_BARS = 64;
const TWO_PI = Math.PI * 2;

export function CircularSpectrumBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const smoothedRef = useRef<Float32Array>(new Float32Array(NUM_BARS));

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

    let rotation = 0;
    let pulsePhase = 0;
    const smoothed = smoothedRef.current;

    function draw() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;
      const audio = getAudioFrame();

      ctx!.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const minDim = Math.min(w, h);
      const baseRadius = minDim * 0.15;
      const maxBarLen = minDim * 0.25;

      // Rotation speed: faster when playing or working
      const rotSpeed = audio.isPlaying ? 0.008 : working ? 0.004 : 0.001;
      rotation += rotSpeed;

      pulsePhase += audio.isPlaying ? 0.06 : working ? 0.03 : 0.015;

      // Map frequency bins to bars
      const binCount = audio.frequencyData.length;
      for (let i = 0; i < NUM_BARS; i++) {
        const start = Math.floor(i * binCount / NUM_BARS);
        const end = Math.min(start + Math.ceil(binCount / NUM_BARS), binCount);
        let sum = 0;
        for (let j = start; j < end; j++) sum += audio.frequencyData[j];
        const raw = (sum / (end - start)) / 255;
        // Smooth
        smoothed[i] = raw > smoothed[i]
          ? smoothed[i] * 0.4 + raw * 0.6
          : smoothed[i] * 0.9 + raw * 0.1;
      }

      // Center pulse based on overall energy
      const pulse = 1 + audio.energy * 0.3 + Math.sin(pulsePhase) * 0.03;
      const currentRadius = baseRadius * pulse;

      // Draw outer glow ring
      const ringGlow = audio.isPlaying ? 0.15 : working ? 0.08 : 0.04;
      const ringGrad = ctx!.createRadialGradient(cx, cy, currentRadius * 0.8, cx, cy, currentRadius * 1.8);
      ringGrad.addColorStop(0, `rgba(100, 140, 255, ${ringGlow})`);
      ringGrad.addColorStop(1, 'rgba(100, 140, 255, 0)');
      ctx!.fillStyle = ringGrad;
      ctx!.beginPath();
      ctx!.arc(cx, cy, currentRadius * 1.8, 0, TWO_PI);
      ctx!.fill();

      // Draw bars
      const barAngle = TWO_PI / NUM_BARS;
      const barWidth = barAngle * 0.6; // visual width as angle fraction

      for (let i = 0; i < NUM_BARS; i++) {
        const angle = rotation + i * barAngle;
        const val = smoothed[i];
        const outerLen = val * maxBarLen;
        const innerLen = val * maxBarLen * 0.4;

        // HSL color: rotate hue around the circle, saturation/lightness from value
        const hue = (i / NUM_BARS) * 360 + rotation * 30;
        const sat = 70 + val * 30;
        const light = 45 + val * 25;
        const alpha = 0.5 + val * 0.5;

        // Outer bar
        if (outerLen > 1) {
          const x1 = cx + Math.cos(angle) * (currentRadius + 4);
          const y1 = cy + Math.sin(angle) * (currentRadius + 4);
          const x2 = cx + Math.cos(angle) * (currentRadius + 4 + outerLen);
          const y2 = cy + Math.sin(angle) * (currentRadius + 4 + outerLen);

          ctx!.save();
          ctx!.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
          ctx!.lineWidth = Math.max(2, currentRadius * barWidth * 0.5);
          ctx!.lineCap = 'round';
          ctx!.shadowColor = `hsla(${hue}, ${sat}%, ${light}%, 0.6)`;
          ctx!.shadowBlur = 8 + val * 12;
          ctx!.beginPath();
          ctx!.moveTo(x1, y1);
          ctx!.lineTo(x2, y2);
          ctx!.stroke();
          ctx!.restore();
        }

        // Inner bar (mirrored, shorter)
        if (innerLen > 1) {
          const ix1 = cx + Math.cos(angle) * (currentRadius - 4);
          const iy1 = cy + Math.sin(angle) * (currentRadius - 4);
          const ix2 = cx + Math.cos(angle) * (currentRadius - 4 - innerLen);
          const iy2 = cy + Math.sin(angle) * (currentRadius - 4 - innerLen);

          ctx!.save();
          ctx!.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha * 0.5})`;
          ctx!.lineWidth = Math.max(1.5, currentRadius * barWidth * 0.35);
          ctx!.lineCap = 'round';
          ctx!.shadowColor = `hsla(${hue}, ${sat}%, ${light}%, 0.3)`;
          ctx!.shadowBlur = 4 + val * 6;
          ctx!.beginPath();
          ctx!.moveTo(ix1, iy1);
          ctx!.lineTo(ix2, iy2);
          ctx!.stroke();
          ctx!.restore();
        }
      }

      // Center ring outline
      ctx!.strokeStyle = `rgba(150, 180, 255, ${audio.isPlaying ? 0.4 : working ? 0.25 : 0.12})`;
      ctx!.lineWidth = 1.5;
      ctx!.shadowColor = 'rgba(150, 180, 255, 0.5)';
      ctx!.shadowBlur = 10;
      ctx!.beginPath();
      ctx!.arc(cx, cy, currentRadius, 0, TWO_PI);
      ctx!.stroke();
      ctx!.shadowBlur = 0;

      // Inner center glow
      const centerGrad = ctx!.createRadialGradient(cx, cy, 0, cx, cy, currentRadius * 0.6);
      const centerAlpha = audio.isPlaying ? 0.12 : working ? 0.06 : 0.03;
      centerGrad.addColorStop(0, `rgba(180, 200, 255, ${centerAlpha})`);
      centerGrad.addColorStop(1, 'rgba(180, 200, 255, 0)');
      ctx!.fillStyle = centerGrad;
      ctx!.beginPath();
      ctx!.arc(cx, cy, currentRadius * 0.6, 0, TWO_PI);
      ctx!.fill();

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
