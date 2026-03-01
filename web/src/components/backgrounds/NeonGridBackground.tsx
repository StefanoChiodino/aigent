import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Neon Grid — Retrowave synthwave scene.
 * Sun is positioned on the right side (open sky, away from the sidebar).
 * Tron wireframe mountains hug both sides of the screen.
 * Minimal clean grid — just enough lines to read the perspective.
 * Idle: slow, moody. Working: faster scroll, stronger glow.
 */

const HORIZON = 0.50;  // horizon as fraction of screen height

// Mountain ridge points — normalized x [0..1], y [0..1] where 0=horizon, 1=peak height
const MTN_LEFT: [number, number][] = [
  [0.00, 0.00],
  [0.01, 0.30],
  [0.05, 0.62],
  [0.09, 0.38],
  [0.14, 0.82],
  [0.19, 0.50],
  [0.24, 0.95],
  [0.29, 0.60],
  [0.33, 0.72],
  [0.37, 0.40],
  [0.41, 0.55],
  [0.44, 0.25],
  [0.47, 0.35],
  [0.50, 0.00],
];

const MTN_RIGHT: [number, number][] = [
  [0.50, 0.00],
  [0.53, 0.28],
  [0.56, 0.42],
  [0.60, 0.18],
  [0.64, 0.75],
  [0.68, 0.45],
  [0.72, 0.88],
  [0.77, 0.52],
  [0.81, 0.65],
  [0.86, 0.38],
  [0.91, 0.70],
  [0.95, 0.32],
  [0.99, 0.48],
  [1.00, 0.00],
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

    function drawSun(vpY: number, working: boolean) {
      // Sun sits on the right side — roughly 78% across
      const sx = w * 0.78;
      const sy = vpY;
      const r = Math.min(w, h) * 0.14;

      ctx!.save();
      // Clip to sky
      ctx!.beginPath();
      ctx!.rect(0, 0, w, vpY + r * 0.15);
      ctx!.clip();

      // Atmospheric halo
      const halo = ctx!.createRadialGradient(sx, sy, r * 0.6, sx, sy, r * 3.2);
      halo.addColorStop(0,   `rgba(255, 100, 20,  ${working ? 0.30 : 0.18})`);
      halo.addColorStop(0.3, `rgba(255, 20,  120, ${working ? 0.20 : 0.10})`);
      halo.addColorStop(0.6, `rgba(120, 0,   200, ${working ? 0.12 : 0.06})`);
      halo.addColorStop(1,   'rgba(0, 0, 0, 0)');
      ctx!.fillStyle = halo;
      ctx!.fillRect(sx - r * 3.5, sy - r * 3.5, r * 7, r * 7);

      // Sun disc — top half only (half hidden behind horizon)
      const disc = ctx!.createLinearGradient(sx, sy - r, sx, sy);
      disc.addColorStop(0,    `rgba(255, 240, 100, ${working ? 1.0 : 0.92})`);
      disc.addColorStop(0.28, `rgba(255, 150, 20,  ${working ? 1.0 : 0.90})`);
      disc.addColorStop(0.65, `rgba(255, 50,  20,  ${working ? 1.0 : 0.88})`);
      disc.addColorStop(1,    `rgba(210, 10,  80,  ${working ? 1.0 : 0.85})`);
      ctx!.beginPath();
      ctx!.arc(sx, sy, r, Math.PI, 0);
      ctx!.closePath();
      ctx!.fillStyle = disc;
      ctx!.fill();

      // Horizontal stripe cutouts
      const stripes = 6;
      for (let s = 0; s < stripes; s++) {
        const frac = s / stripes;
        const bandY  = sy - frac * r * 0.70;
        const thick  = r * (0.09 - frac * 0.01);
        ctx!.fillStyle = `rgba(0, 0, 10, 0.9)`;
        ctx!.fillRect(sx - r - 2, bandY - thick * 0.5, (r + 2) * 2, thick);
      }

      ctx!.restore();
    }

    function drawMountains(
      pts: [number, number][],
      vpY: number,
      working: boolean,
    ) {
      const mtnH = vpY * 0.60; // max mountain height above horizon
      const screen: [number, number][] = pts.map(([nx, ny]) => [
        nx * w,
        vpY - ny * mtnH,
      ]);

      // Dark silhouette fill
      ctx!.beginPath();
      ctx!.moveTo(screen[0][0], vpY + 2);
      for (const [sx, sy] of screen) ctx!.lineTo(sx, sy);
      ctx!.lineTo(screen[screen.length - 1][0], vpY + 2);
      ctx!.closePath();
      ctx!.fillStyle = 'rgba(0, 2, 14, 0.96)';
      ctx!.fill();

      // Glowing ridgeline
      const lineColor = working
        ? 'rgba(0, 210, 255, 0.85)'
        : 'rgba(0, 170, 220, 0.50)';
      ctx!.shadowColor = lineColor;
      ctx!.shadowBlur  = working ? 12 : 6;
      ctx!.beginPath();
      ctx!.moveTo(screen[0][0], screen[0][1]);
      for (const [sx, sy] of screen) ctx!.lineTo(sx, sy);
      ctx!.strokeStyle = lineColor;
      ctx!.lineWidth   = working ? 1.6 : 1.1;
      ctx!.stroke();
      ctx!.shadowBlur = 0;

      // Sparse vertical wireframe lines inside the silhouette
      const step = Math.max(1, Math.floor(screen.length / 5));
      for (let i = step; i < screen.length - step; i += step) {
        const [sx, sy] = screen[i];
        ctx!.beginPath();
        ctx!.moveTo(sx, sy);
        ctx!.lineTo(sx, vpY);
        ctx!.strokeStyle = working
          ? 'rgba(0, 210, 255, 0.18)'
          : 'rgba(0, 170, 220, 0.10)';
        ctx!.lineWidth = 0.7;
        ctx!.stroke();
      }
    }

    function drawGrid(vpY: number, working: boolean) {
      const vpX       = w * 0.5;
      const spread    = w * 0.68;
      const gridH     = h - vpY;
      const lineAlpha = working ? 0.85 : 0.42;
      const bright    = working ? 1.0  : 0.55;

      // Fewer vertical lines — just 6 each side for a clean look
      const vCount = 6;
      for (let i = -vCount; i <= vCount; i++) {
        if (i === 0) continue; // skip dead-center line
        const bx = vpX + (i / vCount) * spread;
        ctx!.beginPath();
        ctx!.moveTo(vpX, vpY);
        ctx!.lineTo(bx, h);
        ctx!.strokeStyle = `rgba(255, 20, 200, ${lineAlpha * 0.65})`;
        ctx!.lineWidth = 0.7;
        ctx!.stroke();
      }

      // Horizontal lines — only ~10 visible, well-spaced
      const hCount = 10;
      for (let j = 0; j < hCount; j++) {
        const raw = (j / hCount + offset) % 1;
        const t   = raw * raw; // perspective bunching
        if (t < 0.005) continue;
        const y     = vpY + t * gridH;
        const lx1   = vpX - spread * t;
        const lx2   = vpX + spread * t;
        const alpha = Math.min(t * 5, 1) * lineAlpha * bright;

        ctx!.beginPath();
        ctx!.moveTo(lx1, y);
        ctx!.lineTo(lx2, y);
        ctx!.strokeStyle = `rgba(0, 215, 255, ${alpha * 0.90})`;
        ctx!.lineWidth = t * 1.6;
        ctx!.stroke();
      }
    }

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const speed   = working ? 0.55 : 0.15;
      offset = (offset + speed * dt) % 1;

      const vpY = h * HORIZON;

      // Sky
      const skyGrad = ctx!.createLinearGradient(0, 0, 0, vpY);
      skyGrad.addColorStop(0,   working ? 'rgb(2, 0, 18)'  : 'rgb(1, 0, 12)');
      skyGrad.addColorStop(0.6, working ? 'rgb(12, 0, 42)' : 'rgb(7, 0, 30)');
      skyGrad.addColorStop(1,   working ? 'rgb(28, 4, 55)' : 'rgb(16, 2, 38)');
      ctx!.fillStyle = skyGrad;
      ctx!.fillRect(0, 0, w, vpY);

      // Ground
      const gndGrad = ctx!.createLinearGradient(0, vpY, 0, h);
      gndGrad.addColorStop(0, working ? 'rgb(18, 0, 40)' : 'rgb(9, 0, 24)');
      gndGrad.addColorStop(1, 'rgb(0, 0, 3)');
      ctx!.fillStyle = gndGrad;
      ctx!.fillRect(0, vpY, w, h - vpY);

      // Horizon glow
      const horizGlow = ctx!.createLinearGradient(0, vpY - 50, 0, vpY + 60);
      horizGlow.addColorStop(0,   'rgba(255, 60, 20, 0)');
      horizGlow.addColorStop(0.4, `rgba(255, 60, 20, ${working ? 0.14 : 0.07})`);
      horizGlow.addColorStop(0.6, `rgba(200, 10, 120, ${working ? 0.10 : 0.05})`);
      horizGlow.addColorStop(1,   'rgba(200, 10, 120, 0)');
      ctx!.fillStyle = horizGlow;
      ctx!.fillRect(0, vpY - 50, w, 110);

      // Sun (draw before mountains so peaks occlude it)
      drawSun(vpY, working);

      // Mountains
      drawMountains(MTN_LEFT,  vpY, working);
      drawMountains(MTN_RIGHT, vpY, working);

      // Grid
      drawGrid(vpY, working);

      // Scanline sweep when working
      if (working) {
        const gridH = h - vpY;
        const sweep = ((time * 0.0002) % 1) * gridH;
        const sy    = vpY + sweep;
        const sg    = ctx!.createLinearGradient(0, sy - 35, 0, sy + 10);
        sg.addColorStop(0, 'rgba(0, 220, 255, 0)');
        sg.addColorStop(0.7, 'rgba(0, 220, 255, 0.09)');
        sg.addColorStop(1,   'rgba(0, 220, 255, 0)');
        ctx!.fillStyle = sg;
        ctx!.fillRect(0, sy - 35, w, 45);
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
