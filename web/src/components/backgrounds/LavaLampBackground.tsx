import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Lava Lamp — slow-moving metaball blobs that rise, drift, and merge.
 * Idle: warm oranges/reds on dark purple, sluggish. Working: faster, more blobs, brighter.
 *
 * Anti-aliasing strategy: render the metaball alpha field to a small off-screen canvas,
 * then use CSS filter: blur + contrast on a wrapper element to get free GPU-side smooth
 * blob edges (the classic CSS metaball trick). A second canvas draws the colour fill.
 */

interface Blob {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
  phase: number;
  wobbleAmp: number;
  wobbleSpeed: number;
}

function spawnBlob(w: number, h: number): Blob {
  const hot = Math.random() > 0.3;
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 12,
    vy: -(5 + Math.random() * 15),
    r: 70 + Math.random() * 110,
    hue: hot ? Math.random() * 40 : 270 + Math.random() * 40,
    phase: Math.random() * Math.PI * 2,
    wobbleAmp: 5 + Math.random() * 15,
    wobbleSpeed: 0.3 + Math.random() * 0.8,
  };
}

// Resolution divisor for the off-screen field canvas (2 = half res)
const RES = 2;

export function LavaLampBackground() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const alphaCanvasRef = useRef<HTMLCanvasElement>(null);
  const colorCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const blobsRef = useRef<Blob[]>([]);
  const isWorking = useUIStore(s => s.isLoading);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const alphaCanvas = alphaCanvasRef.current;
    const colorCanvas = colorCanvasRef.current;
    if (!wrapper || !alphaCanvas || !colorCanvas) return;

    const alphaCtx = alphaCanvas.getContext('2d');
    const colorCtx = colorCanvas.getContext('2d');
    if (!alphaCtx || !colorCtx) return;

    let w = window.innerWidth;
    let h = window.innerHeight;
    let ow = Math.ceil(w / RES);
    let oh = Math.ceil(h / RES);
    let imgData: ImageData;

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      ow = Math.ceil(w / RES);
      oh = Math.ceil(h / RES);

      // Alpha canvas: half resolution, used for the blur+contrast trick
      alphaCanvas!.width = ow;
      alphaCanvas!.height = oh;
      alphaCanvas!.style.width = w + 'px';
      alphaCanvas!.style.height = h + 'px';
      imgData = alphaCtx!.createImageData(ow, oh);

      // Color canvas: same full size, drawn on top
      const dpr = window.devicePixelRatio || 1;
      colorCanvas!.width = w * dpr;
      colorCanvas!.height = h * dpr;
      colorCanvas!.style.width = w + 'px';
      colorCanvas!.style.height = h + 'px';
      colorCtx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener('resize', resize);

    // Seed initial blobs
    for (let i = 0; i < 8; i++) blobsRef.current.push(spawnBlob(w, h));

    let lastTime = 0;

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const blobs = blobsRef.current;
      const targetCount = working ? 12 : 8;

      while (blobs.length < targetCount) blobs.push(spawnBlob(w, h));
      if (blobs.length > targetCount + 2) blobs.splice(targetCount + 2);

      const speedMult = working ? 2.2 : 1.0;

      // Update blob physics
      for (const b of blobs) {
        b.phase += b.wobbleSpeed * dt;
        b.x += (b.vx + Math.sin(b.phase) * b.wobbleAmp) * dt * speedMult;
        b.y += b.vy * dt * speedMult;

        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r * 1.5) { b.y = h + b.r; b.vy = -(5 + Math.random() * 15); b.x = Math.random() * w; }
        if (b.y > h + b.r * 1.5) { b.y = -b.r; b.vy = 5 + Math.random() * 15; }
        if (b.y < h * 0.1 && b.vy < 0) b.vy *= 0.97;
        if (b.y > h * 0.9 && b.vy > 0) b.vy *= 0.97;
        b.vy += (Math.random() - 0.5) * 2 * dt;
        b.vy = Math.max(-30, Math.min(30, b.vy));
      }

      // ── Alpha pass: write grayscale metaball field ─────────────────────────
      // Each pixel gets white alpha proportional to the metaball field value.
      // The CSS blur+contrast on the wrapper converts this to crisp, smooth blobs.
      const THRESHOLD = 1.0;
      const data = imgData.data;
      for (let py = 0; py < oh; py++) {
        for (let px = 0; px < ow; px++) {
          const wx = px * RES + RES / 2;
          const wy = py * RES + RES / 2;

          let field = 0;
          let wHue = 0;
          let wSat = 0;

          for (const b of blobs) {
            const dx = wx - b.x;
            const dy = wy - b.y;
            const contrib = (b.r * b.r) / (dx * dx + dy * dy + 1);
            field += contrib;
            wHue += contrib * b.hue;
            wSat += contrib * (b.hue < 50 ? 100 : 80);
          }

          const idx = (py * ow + px) * 4;
          // Smooth alpha near threshold so blur+contrast gives clean edges
          const alpha = Math.min(Math.max((field - 0.6) / 0.8, 0), 1);

          if (alpha > 0) {
            const hue = wHue / field;
            const sat = wSat / field;
            const bright = Math.min(field / THRESHOLD, 2.5);
            const lightness = working ? 45 + bright * 12 : 38 + bright * 10;
            // HSL → RGB inline
            const l = lightness / 100;
            const s = sat / 100;
            const c = (1 - Math.abs(2 * l - 1)) * s;
            const xv = c * (1 - Math.abs((hue / 60) % 2 - 1));
            const m = l - c / 2;
            let r = 0, g = 0, bv = 0;
            if (hue < 60) { r = c; g = xv; }
            else if (hue < 120) { r = xv; g = c; }
            else if (hue < 180) { g = c; bv = xv; }
            else if (hue < 240) { g = xv; bv = c; }
            else if (hue < 300) { r = xv; bv = c; }
            else { r = c; bv = xv; }
            data[idx]     = Math.round((r + m) * 255);
            data[idx + 1] = Math.round((g + m) * 255);
            data[idx + 2] = Math.round((bv + m) * 255);
            data[idx + 3] = Math.round(alpha * 230);
          } else {
            data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 0;
          }
        }
      }
      alphaCtx!.putImageData(imgData, 0, 0);

      // ── Color canvas: background + vignette ───────────────────────────────
      colorCtx!.clearRect(0, 0, w, h);

      // Deep background
      const bg = colorCtx!.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, 'rgb(8, 3, 18)');
      bg.addColorStop(1, 'rgb(4, 1, 12)');
      colorCtx!.fillStyle = bg;
      colorCtx!.fillRect(0, 0, w, h);

      // Vignette
      const vig = colorCtx!.createRadialGradient(w / 2, h / 2, h * 0.15, w / 2, h / 2, h * 0.85);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, `rgba(0,0,0,${working ? 0.4 : 0.55})`);
      colorCtx!.fillStyle = vig;
      colorCtx!.fillRect(0, 0, w, h);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animRef.current);
    };
  }, []);

  return (
    // The wrapper applies blur+contrast: this is the CSS metaball trick.
    // blur blends nearby pixels; contrast re-sharpens — the result is crisp,
    // anti-aliased blob edges with zero per-pixel CPU work.
    <div
      ref={wrapperRef}
      className="theme-canvas-bg"
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, zIndex: 0 }}
    >
      {/* Background + vignette layer (no filter) */}
      <canvas
        ref={colorCanvasRef}
        style={{ position: 'absolute', inset: 0 }}
      />
      {/* Metaball blob layer with blur+contrast filter */}
      <canvas
        ref={alphaCanvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          filter: 'blur(18px) contrast(14)',
          imageRendering: 'auto',
        }}
      />
    </div>
  );
}
