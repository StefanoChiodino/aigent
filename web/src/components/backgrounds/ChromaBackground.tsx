import React, { useEffect, useRef } from 'react';

// Curated palette ordered so hues step continuously around the colour wheel —
// no large jumps, so every crossfade feels gradual.
// Format: [hue 0-360, saturation%, lightness%]
const PALETTE: [number, number, number][] = [
  [200, 38, 17],  // slate cyan
  [225, 38, 18],  // periwinkle
  [250, 33, 18],  // soft indigo
  [280, 30, 17],  // dusty violet
  [310, 28, 17],  // muted mauve
  [340, 33, 17],  // dusty rose
  [10,  35, 18],  // terracotta
  [35,  36, 18],  // warm amber
  [55,  33, 17],  // muted gold
  [100, 28, 16],  // sage green
  [155, 30, 16],  // cool sage
  [180, 32, 16],  // teal
];

// How long to spend on each colour (ms)
const DWELL_MS = 7000;
// How long the crossfade between colours takes (ms)
const FADE_MS  = 6000;

export function ChromaBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = window.innerWidth;
    let h = window.innerHeight;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      w = window.innerWidth;
      h = window.innerHeight;
      canvas!.width  = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width  = w + 'px';
      canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener('resize', resize);

    // Track where we are in the cycle
    let elapsed = 0;       // ms since we entered the current colour
    let fromIdx = 0;
    let toIdx   = 1;
    let inFade  = false;   // are we currently crossfading?

    let lastTime = performance.now();

    function hsl(h: number, s: number, l: number, a = 1) {
      return `hsla(${h},${s}%,${l}%,${a})`;
    }

    function easeInOut(t: number) {
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    }

    function draw(now: number) {
      const dt = Math.min(now - lastTime, 100);
      lastTime = now;
      elapsed += dt;

      // Advance state machine
      if (!inFade) {
        if (elapsed >= DWELL_MS) { inFade = true; elapsed = 0; }
      } else {
        if (elapsed >= FADE_MS) {
          fromIdx = toIdx;
          toIdx   = (toIdx + 1) % PALETTE.length;
          inFade  = false;
          elapsed = 0;
        }
      }

      // Interpolation factor (0 during dwell, 0→1 during fade)
      const t = inFade ? easeInOut(Math.min(elapsed / FADE_MS, 1)) : 0;

      // Interpolate hue via shortest arc
      const ca = PALETTE[fromIdx];
      const cb = PALETTE[toIdx];
      let dh = cb[0] - ca[0];
      if (dh > 180)  dh -= 360;
      if (dh < -180) dh += 360;
      const curH = ca[0] + dh * t;
      const curS = ca[1] + (cb[1] - ca[1]) * t;
      const curL = ca[2] + (cb[2] - ca[2]) * t;

      // Radial gradient: slightly brighter centre for a gentle glow effect
      const cx = w / 2;
      const cy = h / 2;
      const r  = Math.max(w, h) * 0.75;

      const grad = ctx!.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, hsl(curH, curS, Math.min(curL + 6, 40)));
      grad.addColorStop(1, hsl(curH, curS, curL));

      ctx!.fillStyle = grad;
      ctx!.fillRect(0, 0, w, h);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animRef.current);
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
