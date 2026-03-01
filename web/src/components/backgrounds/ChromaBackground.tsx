import React, { useEffect, useRef } from 'react';

// Curated palette of soft, beautiful hues (HSL: hue, saturation%, lightness%)
// Kept low-saturation and mid-lightness so they never feel garish
const PALETTE: [number, number, number][] = [
  [210, 40, 18],  // steel blue
  [260, 35, 18],  // indigo violet
  [300, 30, 17],  // soft magenta
  [340, 35, 17],  // dusty rose
  [20,  38, 18],  // warm amber
  [50,  35, 17],  // muted gold
  [160, 35, 16],  // sage teal
  [190, 38, 17],  // slate cyan
];

// How long to spend on each colour (ms)
const DWELL_MS = 8000;
// How long the crossfade between colours takes (ms)
const FADE_MS  = 4000;

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

    // Lerp between two PALETTE entries, returns CSS colour string
    function lerpHSL(a: [number, number, number], b: [number, number, number], t: number): string {
      // Interpolate hue via the shortest arc
      let dh = b[0] - a[0];
      if (dh > 180)  dh -= 360;
      if (dh < -180) dh += 360;
      const hue = a[0] + dh * t;
      const sat = a[1] + (b[1] - a[1]) * t;
      const lit = a[2] + (b[2] - a[2]) * t;
      return `hsl(${hue},${sat}%,${lit}%)`;
    }

    function easeInOut(t: number) {
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    }

    function draw(now: number) {
      const dt = Math.min(now - lastTime, 100);
      lastTime = now;
      elapsed += dt;

      let colour: string;

      if (!inFade) {
        // Dwelling on fromIdx colour
        colour = hsl(...PALETTE[fromIdx]);
        if (elapsed >= DWELL_MS) {
          inFade  = true;
          elapsed = 0;
        }
      } else {
        // Crossfading from → to
        const t = easeInOut(Math.min(elapsed / FADE_MS, 1));
        colour = lerpHSL(PALETTE[fromIdx], PALETTE[toIdx], t);
        if (elapsed >= FADE_MS) {
          fromIdx = toIdx;
          toIdx   = (toIdx + 1) % PALETTE.length;
          inFade  = false;
          elapsed = 0;
        }
      }

      // Radial gradient: slightly brighter centre, fades to the current hue at edges
      // This gives a natural vignette feel rather than a flat wash
      const from_hsl = PALETTE[fromIdx];
      const cx = w / 2;
      const cy = h / 2;
      const r  = Math.max(w, h) * 0.75;

      const grad = ctx!.createRadialGradient(cx, cy, 0, cx, cy, r);

      // Centre: bump lightness by ~6pts for a gentle glow
      if (!inFade) {
        const [hv, sv, lv] = from_hsl;
        grad.addColorStop(0,   hsl(hv, sv, Math.min(lv + 6, 40)));
        grad.addColorStop(1,   colour);
      } else {
        // During fade, just use the interpolated colour uniformly — gradient
        // variation is barely visible mid-transition and adds complexity for no gain
        grad.addColorStop(0, colour);
        grad.addColorStop(1, colour);
      }

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
