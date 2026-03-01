import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Neon Grid — Retrowave/Tron synthwave scene.
 * Large segmented sun on the horizon, Tron-style wireframe mountains on sides,
 * perspective grid rushing toward the viewer like driving into the sunset.
 * Idle: slow scroll, moody. Working: fast scroll, intense glow, scanline pulse.
 */

const HORIZON = 0.48;    // horizon as fraction of screen height
const V_LINES = 12;      // vertical grid lines each side of center
const H_LINES = 24;      // horizontal lines in the grid field
const VP_X = 0.5;        // vanishing point x fraction

// Mountain silhouette points — normalized [0,1] x, [0,1] y (0=top, 1=horizon)
// Two overlapping ranges: left cluster and right cluster
const MOUNTAINS_LEFT: [number, number][] = [
  [0.0,  0.95],
  [0.02, 0.60],
  [0.07, 0.30],
  [0.12, 0.55],
  [0.17, 0.20],
  [0.22, 0.45],
  [0.27, 0.65],
  [0.32, 0.35],
  [0.37, 0.58],
  [0.41, 0.80],
  [0.45, 0.70],
  [0.50, 1.00],
];
const MOUNTAINS_RIGHT: [number, number][] = [
  [0.50, 1.00],
  [0.55, 0.72],
  [0.59, 0.82],
  [0.63, 0.40],
  [0.68, 0.62],
  [0.73, 0.22],
  [0.78, 0.48],
  [0.83, 0.18],
  [0.88, 0.52],
  [0.93, 0.38],
  [0.98, 0.68],
  [1.00, 0.92],
];

export function NeonGridBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const isWorking = useUIStore(s => s.isLoading);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;

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
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + 'px';
      canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener('resize', resize);

    let offset = 0;
    let lastTime = 0;
    let scanY = 0;

    /** Draw the perspective grid (ground plane) */
    function drawGrid(vpX: number, vpY: number, working: boolean) {
      const gridBottom = h;
      const gridHeight = gridBottom - vpY;
      const spread = w * 0.72;
      const lineAlpha = working ? 0.9 : 0.5;
      const bright = working ? 1.0 : 0.55;

      // Vertical lines radiating from vanishing point
      for (let i = -V_LINES; i <= V_LINES; i++) {
        const bx = vpX + (i / V_LINES) * spread;
        const isCenterish = Math.abs(i) <= 1;
        ctx!.shadowBlur = (working && isCenterish) ? 10 : 0;
        ctx!.shadowColor = 'rgba(255, 20, 200, 0.8)';
        ctx!.beginPath();
        ctx!.moveTo(vpX, vpY);
        ctx!.lineTo(bx, gridBottom);
        ctx!.strokeStyle = `rgba(255, 20, 200, ${lineAlpha * (isCenterish ? 1.0 : 0.7)})`;
        ctx!.lineWidth = isCenterish ? 1.2 : 0.7;
        ctx!.stroke();
        ctx!.shadowBlur = 0;
      }

      // Horizontal lines with perspective spacing
      for (let j = 0; j < H_LINES; j++) {
        const raw = (j / H_LINES + offset) % 1;
        const t = raw * raw; // perspective bunching near horizon
        if (t < 0.001) continue;
        const y = vpY + t * gridHeight;
        const lineX1 = vpX - spread * t;
        const lineX2 = vpX + spread * t;
        const depthAlpha = Math.min(t * 6, 1) * lineAlpha * bright;
        // Primarily cyan, subtle pink on every 3rd
        const isCyan = j % 3 !== 0;
        const color = isCyan
          ? `rgba(0, 220, 255, ${depthAlpha * 0.95})`
          : `rgba(255, 20, 200, ${depthAlpha * 0.6})`;
        ctx!.beginPath();
        ctx!.moveTo(lineX1, y);
        ctx!.lineTo(lineX2, y);
        ctx!.strokeStyle = color;
        ctx!.lineWidth = t * 1.8;
        ctx!.stroke();
      }
    }

    /** Draw mountain wireframe silhouette on one side */
    function drawMountains(
      pts: [number, number][],
      vpX: number, vpY: number,
      working: boolean,
    ) {
      const mountainH = vpY * 0.65; // how tall the mountain zone is above horizon
      const glowColor = working ? 'rgba(0, 220, 255, 0.9)' : 'rgba(0, 180, 220, 0.55)';
      const fillColor = working ? 'rgba(0, 5, 25, 0.92)' : 'rgba(0, 3, 18, 0.95)';

      // Map normalized points to screen coords
      const screen: [number, number][] = pts.map(([nx, ny]) => [
        nx * w,
        vpY - ny * mountainH,
      ]);

      // Fill silhouette (dark, blocks the sky)
      ctx!.beginPath();
      ctx!.moveTo(screen[0][0], vpY + 2);
      for (const [sx, sy] of screen) ctx!.lineTo(sx, sy);
      ctx!.lineTo(screen[screen.length - 1][0], vpY + 2);
      ctx!.closePath();
      ctx!.fillStyle = fillColor;
      ctx!.fill();

      // Draw wireframe ridgeline with glow
      ctx!.shadowColor = glowColor;
      ctx!.shadowBlur = working ? 14 : 7;
      ctx!.beginPath();
      ctx!.moveTo(screen[0][0], screen[0][1]);
      for (const [sx, sy] of screen) ctx!.lineTo(sx, sy);
      ctx!.strokeStyle = glowColor;
      ctx!.lineWidth = working ? 1.8 : 1.2;
      ctx!.stroke();
      ctx!.shadowBlur = 0;

      // Interior wireframe lines (vertical down to horizon) — sparse
      const stride = Math.max(1, Math.floor(screen.length / 6));
      for (let i = stride; i < screen.length - stride; i += stride) {
        const [sx, sy] = screen[i];
        ctx!.beginPath();
        ctx!.moveTo(sx, sy);
        ctx!.lineTo(sx, vpY);
        ctx!.strokeStyle = working
          ? 'rgba(0, 220, 255, 0.25)'
          : 'rgba(0, 180, 220, 0.15)';
        ctx!.lineWidth = 0.6;
        ctx!.stroke();
      }
    }

    /** Draw the large retrowave sun with horizontal stripe cutouts */
    function drawSun(vpX: number, vpY: number, working: boolean) {
      const sunR = Math.min(w, h) * 0.16; // radius proportional to screen
      const sunCY = vpY; // sun center sits right on the horizon

      // Outer atmospheric glow
      const atmGrad = ctx!.createRadialGradient(vpX, sunCY, sunR * 0.5, vpX, sunCY, sunR * 2.8);
      atmGrad.addColorStop(0, `rgba(255, 80, 30, ${working ? 0.32 : 0.18})`);
      atmGrad.addColorStop(0.35, `rgba(255, 20, 120, ${working ? 0.22 : 0.10})`);
      atmGrad.addColorStop(0.7, `rgba(130, 0, 180, ${working ? 0.12 : 0.06})`);
      atmGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx!.save();
      // Clip to sky (above horizon) so sun doesn't bleed into ground
      ctx!.beginPath();
      ctx!.rect(0, 0, w, vpY + sunR * 0.3); // allow a tiny bleed at horizon
      ctx!.clip();

      ctx!.fillStyle = atmGrad;
      ctx!.fillRect(vpX - sunR * 3, sunCY - sunR * 3, sunR * 6, sunR * 6);

      // Sun disc — gradient from yellow-white core to deep orange/red rim
      const sunGrad = ctx!.createLinearGradient(vpX, sunCY - sunR, vpX, sunCY);
      sunGrad.addColorStop(0, `rgba(255, 240, 80, ${working ? 1.0 : 0.9})`);
      sunGrad.addColorStop(0.25, `rgba(255, 160, 20, ${working ? 1.0 : 0.88})`);
      sunGrad.addColorStop(0.6, `rgba(255, 60, 20, ${working ? 1.0 : 0.85})`);
      sunGrad.addColorStop(1, `rgba(220, 20, 80, ${working ? 1.0 : 0.82})`);

      // Draw full disc
      ctx!.beginPath();
      ctx!.arc(vpX, sunCY, sunR, Math.PI, 0); // upper half only (rises above horizon)
      ctx!.closePath();
      ctx!.fillStyle = sunGrad;
      ctx!.fill();

      // Retrowave horizontal stripe cutouts (cut from disc with dark bands)
      const stripeCount = 6;
      const stripeZone = sunR * 0.85; // zone from bottom of semicircle
      for (let s = 0; s < stripeCount; s++) {
        const frac = s / stripeCount;
        // Stripes start near the bottom (close to horizon) and get thinner going up
        const bandY = sunCY - frac * stripeZone * 0.72;
        const thickness = (1 - frac * 0.5) * sunR * 0.085;
        // Gap below each stripe
        const gapY = bandY - thickness * 0.7;
        // Clip to disc shape when drawing stripes
        ctx!.fillStyle = `rgba(0, 0, 8, ${0.88 + frac * 0.08})`;
        ctx!.fillRect(vpX - sunR - 2, gapY, (sunR + 2) * 2, thickness);
      }

      // Thin horizon glow line
      ctx!.strokeStyle = `rgba(255, 80, 20, ${working ? 0.8 : 0.5})`;
      ctx!.lineWidth = working ? 2.5 : 1.5;
      ctx!.shadowColor = 'rgba(255, 120, 20, 0.9)';
      ctx!.shadowBlur = working ? 18 : 10;
      ctx!.beginPath();
      ctx!.moveTo(0, vpY);
      ctx!.lineTo(w, vpY);
      ctx!.stroke();
      ctx!.shadowBlur = 0;

      ctx!.restore();
    }

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const speed = working ? 0.6 : 0.16;
      offset = (offset + speed * dt) % 1;

      const vpX = w * VP_X;
      const vpY = h * HORIZON;

      // ---- Sky ----
      const skyGrad = ctx!.createLinearGradient(0, 0, 0, vpY);
      skyGrad.addColorStop(0, working ? 'rgb(2, 0, 18)' : 'rgb(1, 0, 12)');
      skyGrad.addColorStop(0.5, working ? 'rgb(10, 0, 40)' : 'rgb(6, 0, 28)');
      skyGrad.addColorStop(1, working ? 'rgb(30, 5, 60)' : 'rgb(18, 2, 40)');
      ctx!.fillStyle = skyGrad;
      ctx!.fillRect(0, 0, w, vpY);

      // ---- Ground ----
      const groundGrad = ctx!.createLinearGradient(0, vpY, 0, h);
      groundGrad.addColorStop(0, working ? 'rgb(20, 0, 45)' : 'rgb(10, 0, 28)');
      groundGrad.addColorStop(1, 'rgb(0, 0, 4)');
      ctx!.fillStyle = groundGrad;
      ctx!.fillRect(0, vpY, w, h - vpY);

      // ---- Sun (draw before mountains so mountains occlude it) ----
      drawSun(vpX, vpY, working);

      // ---- Mountains ----
      drawMountains(MOUNTAINS_LEFT, vpX, vpY, working);
      drawMountains(MOUNTAINS_RIGHT, vpX, vpY, working);

      // ---- Perspective grid ----
      drawGrid(vpX, vpY, working);

      // ---- Scanline sweep when working ----
      if (working) {
        scanY += 200 * dt;
        const gridHeight = h - vpY;
        if (scanY > gridHeight) scanY = 0;
        const sy = vpY + scanY;
        const scanGrad = ctx!.createLinearGradient(0, sy - 40, 0, sy + 12);
        scanGrad.addColorStop(0, 'rgba(0, 220, 255, 0)');
        scanGrad.addColorStop(0.65, 'rgba(0, 220, 255, 0.12)');
        scanGrad.addColorStop(1, 'rgba(0, 220, 255, 0)');
        ctx!.fillStyle = scanGrad;
        ctx!.fillRect(0, sy - 40, w, 52);
      }

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
