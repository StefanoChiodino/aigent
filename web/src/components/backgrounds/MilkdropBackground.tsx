import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';
import { useVoiceStore } from '../../stores/voice';
import { initAudioAnalysis, getAudioFrame, destroyAudioAnalysis } from '../../hooks/useAudioAnalysis';

/**
 * Milkdrop — kaleidoscopic psychedelic patterns that morph with audio.
 * Perlin noise field with polar coordinate warping, 6-fold symmetry,
 * and HSL color mapping.  Rendered at reduced resolution for natural
 * softness and performance.  Dreamy lava-lamp when idle; vivid and
 * energetic when audio plays.
 */

// ── Perlin noise (same approach as TopologyBackground) ──────────────────────

const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  PERM.set(p);
  PERM.set(p, 256);
}

function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a: number, b: number, t: number) { return a + t * (b - a); }
function grad(hash: number, x: number, y: number): number {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

function noise(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
    v,
  );
}

function fbm(x: number, y: number, octaves: number): number {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

// ── Component ───────────────────────────────────────────────────────────────

const SYMMETRY = 6; // kaleidoscope fold count
const PIXEL_SCALE = 4; // render at 1/4 resolution

export function MilkdropBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
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

    // Offscreen canvas at reduced resolution
    const off = document.createElement('canvas');
    offRef.current = off;
    const oCtx = off.getContext('2d');
    if (!oCtx) return;

    initAudioAnalysis();

    let offW = 0, offH = 0;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + 'px';
      canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      offW = Math.ceil(w / PIXEL_SCALE);
      offH = Math.ceil(h / PIXEL_SCALE);
      off.width = offW;
      off.height = offH;
    }

    resize();
    window.addEventListener('resize', resize);

    let time = 0;
    let lastDrawTime = 0;

    function draw(now: number) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;
      const audio = getAudioFrame();

      const isStandby = !audio.isPlaying && !working;

      // On standby, throttle to ~10fps to reduce flicker
      if (isStandby && now - lastDrawTime < 100) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawTime = now;

      // Time progression: faster with audio/working, barely drifting on standby
      const speed = audio.isPlaying ? 0.025 : working ? 0.012 : 0.0005;
      time += speed;

      // Audio modulation parameters
      const warpAmp = audio.isPlaying ? 0.8 + audio.bassEnergy * 2.5 : working ? 0.8 : 0.15;
      const colorSpeed = 0.3 + audio.trebleEnergy * 1.5;
      const noiseFreq = audio.isPlaying ? 1.5 + audio.midEnergy * 2.0 : working ? 1.5 : 0.8;
      const brightness = audio.isPlaying ? 0.7 : working ? 0.45 : 0.15;

      const imgData = oCtx!.createImageData(offW, offH);
      const data = imgData.data;

      const cx = offW / 2;
      const cy = offH / 2;
      const maxR = Math.sqrt(cx * cx + cy * cy);

      for (let py = 0; py < offH; py++) {
        for (let px = 0; px < offW; px++) {
          // Convert to polar coordinates centered
          let dx = px - cx;
          let dy = py - cy;
          let r = Math.sqrt(dx * dx + dy * dy) / maxR;
          let angle = Math.atan2(dy, dx);

          // Kaleidoscope symmetry: fold the angle
          const segAngle = (Math.PI * 2) / SYMMETRY;
          angle = ((angle % segAngle) + segAngle) % segAngle;
          if (angle > segAngle / 2) angle = segAngle - angle; // mirror within segment

          // Warp polar coordinates with noise (fewer octaves on standby)
          const warpOct = isStandby ? 2 : 3;
          const warpX = fbm(r * noiseFreq + time, angle * 2 + time * 0.3, warpOct) * warpAmp;
          const warpY = fbm(angle * 2 + time * 0.5, r * noiseFreq - time * 0.2, warpOct) * warpAmp;

          // Sample noise at warped position (fewer octaves on standby)
          const sampleOct = isStandby ? 2 : 4;
          const n1 = fbm(r * 3 + warpX + time * 0.4, angle * 3 + warpY, sampleOct);
          const n2 = fbm(r * 2 - warpY + time * 0.3, angle * 2 + warpX + time * 0.2, isStandby ? 2 : 3);

          // Map noise to HSL color
          const hue = ((n1 + 0.5) * 180 + time * colorSpeed * 60 + r * 120) % 360;
          const sat = isStandby ? 50 + n2 * 30 : 60 + n2 * 40;
          const light = (n1 + 0.5) * 50 * brightness + 10;

          // HSL to RGB (inline for performance)
          const sl = sat / 100;
          const ll = light / 100;
          const c = (1 - Math.abs(2 * ll - 1)) * sl;
          const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
          const m = ll - c / 2;
          let rr: number, gg: number, bb: number;
          const h6 = hue / 60;
          if (h6 < 1) { rr = c; gg = x; bb = 0; }
          else if (h6 < 2) { rr = x; gg = c; bb = 0; }
          else if (h6 < 3) { rr = 0; gg = c; bb = x; }
          else if (h6 < 4) { rr = 0; gg = x; bb = c; }
          else if (h6 < 5) { rr = x; gg = 0; bb = c; }
          else { rr = c; gg = 0; bb = x; }

          const idx = (py * offW + px) * 4;
          data[idx] = Math.floor((rr + m) * 255);
          data[idx + 1] = Math.floor((gg + m) * 255);
          data[idx + 2] = Math.floor((bb + m) * 255);
          data[idx + 3] = 255;
        }
      }

      oCtx!.putImageData(imgData, 0, 0);

      // Render scaled-up offscreen canvas to main canvas
      ctx!.clearRect(0, 0, w, h);
      ctx!.imageSmoothingEnabled = true;
      ctx!.imageSmoothingQuality = 'medium';
      ctx!.drawImage(off, 0, 0, offW, offH, 0, 0, w, h);

      // Vignette for depth
      const vGrad = ctx!.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.7);
      vGrad.addColorStop(0, 'rgba(0,0,0,0)');
      vGrad.addColorStop(1, 'rgba(0,0,0,0.5)');
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
