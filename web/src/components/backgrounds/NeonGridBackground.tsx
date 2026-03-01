import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Neon Grid — Tron/synthwave perspective grid scrolling toward the viewer.
 * Idle: slow scroll, dim pink/cyan lines. Working: faster, brighter, scanline pulse.
 */

// Horizon position as a fraction of screen height
const HORIZON = 0.45;
// How many vertical grid lines (each side of center)
const V_LINES = 10;
// How many horizontal lines visible in the field
const H_LINES = 20;
// Vanishing point x fraction
const VP_X = 0.5;

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

    let offset = 0; // 0-1, scroll cycle position
    let lastTime = 0;
    let scanY = 0;  // scanline y position (pixels from horizon)

    function drawLine(
      x1: number, y1: number, x2: number, y2: number,
      color: string, lineWidth: number, glow: boolean,
    ) {
      if (glow) {
        ctx!.shadowColor = color;
        ctx!.shadowBlur = 8;
      } else {
        ctx!.shadowBlur = 0;
      }
      ctx!.beginPath();
      ctx!.moveTo(x1, y1);
      ctx!.lineTo(x2, y2);
      ctx!.strokeStyle = color;
      ctx!.lineWidth = lineWidth;
      ctx!.stroke();
      ctx!.shadowBlur = 0;
    }

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const speed = working ? 0.55 : 0.18; // grid scroll speed (0-1/sec)
      offset = (offset + speed * dt) % 1;

      const vpX = w * VP_X;
      const vpY = h * HORIZON;
      const gridBottom = h;
      const gridHeight = gridBottom - vpY;

      // Sky background gradient
      const skyGrad = ctx!.createLinearGradient(0, 0, 0, vpY);
      skyGrad.addColorStop(0, 'rgb(0, 0, 15)');
      skyGrad.addColorStop(1, working ? 'rgb(10, 0, 30)' : 'rgb(5, 0, 20)');
      ctx!.fillStyle = skyGrad;
      ctx!.fillRect(0, 0, w, vpY);

      // Ground background gradient
      const groundGrad = ctx!.createLinearGradient(0, vpY, 0, gridBottom);
      groundGrad.addColorStop(0, working ? 'rgb(15, 0, 35)' : 'rgb(8, 0, 20)');
      groundGrad.addColorStop(1, 'rgb(0, 0, 5)');
      ctx!.fillStyle = groundGrad;
      ctx!.fillRect(0, vpY, w, gridBottom - vpY);

      // Horizon glow
      const horizGlow = ctx!.createLinearGradient(0, vpY - 40, 0, vpY + 60);
      horizGlow.addColorStop(0, 'rgba(255, 30, 180, 0)');
      horizGlow.addColorStop(0.4, `rgba(255, 30, 180, ${working ? 0.18 : 0.08})`);
      horizGlow.addColorStop(0.6, `rgba(30, 200, 255, ${working ? 0.18 : 0.08})`);
      horizGlow.addColorStop(1, 'rgba(30, 200, 255, 0)');
      ctx!.fillStyle = horizGlow;
      ctx!.fillRect(0, vpY - 40, w, 100);

      const bright = working ? 1.0 : 0.55;
      const lineAlpha = working ? 0.85 : 0.45;

      // Vertical perspective lines (radiate from vanishing point)
      for (let i = -V_LINES; i <= V_LINES; i++) {
        const spread = w * 0.7; // half-width of grid at screen bottom
        const bx = vpX + (i / V_LINES) * spread;
        drawLine(
          vpX, vpY, bx, gridBottom,
          `rgba(255, 30, 200, ${lineAlpha * 0.8})`,
          i === 0 ? 1.5 : 0.8,
          working && Math.abs(i) < 2,
        );
      }

      // Horizontal lines (perspective-projected)
      // Each line is a fraction of the way down from horizon.
      // Use exponential spacing to simulate perspective.
      for (let j = 0; j < H_LINES; j++) {
        // t goes from 0 (at horizon) to 1 (at bottom)
        // Add offset for scrolling, wrap in [0,1]
        const raw = (j / H_LINES + offset) % 1;
        // Perspective warp: lines bunch near horizon
        const t = raw * raw;
        if (t < 0.001) continue; // skip lines at exact horizon (invisible)
        const y = vpY + t * gridHeight;

        // Width of the line at this depth = lerp from 0 at horizon to full at bottom
        const lineX1 = vpX + (-(w * 0.7)) * t;
        const lineX2 = vpX + (w * 0.7) * t;

        // Fade out lines very close to horizon
        const depthAlpha = Math.min(t * 8, 1) * lineAlpha * bright;

        // Alternating cyan/pink for variety
        const color = j % 2 === 0
          ? `rgba(30, 220, 255, ${depthAlpha * 0.9})`
          : `rgba(255, 30, 200, ${depthAlpha * 0.5})`;

        drawLine(lineX1, y, lineX2, y, color, t * 1.5, false);
      }

      // Scanline sweep effect when working
      if (working) {
        scanY += 180 * dt;
        if (scanY > gridHeight) scanY = 0;
        const sy = vpY + scanY;
        const scanGrad = ctx!.createLinearGradient(0, sy - 30, 0, sy + 10);
        scanGrad.addColorStop(0, 'rgba(30, 220, 255, 0)');
        scanGrad.addColorStop(0.6, 'rgba(30, 220, 255, 0.15)');
        scanGrad.addColorStop(1, 'rgba(30, 220, 255, 0)');
        ctx!.fillStyle = scanGrad;
        ctx!.fillRect(0, sy - 30, w, 40);
      }

      // Sun / moon on horizon
      const sunGrad = ctx!.createRadialGradient(vpX, vpY, 0, vpX, vpY, 120);
      sunGrad.addColorStop(0, `rgba(255, 30, 200, ${working ? 0.6 : 0.35})`);
      sunGrad.addColorStop(0.3, `rgba(200, 0, 120, ${working ? 0.3 : 0.15})`);
      sunGrad.addColorStop(1, 'rgba(100, 0, 80, 0)');
      // Clip to sky only
      ctx!.save();
      ctx!.beginPath();
      ctx!.rect(0, 0, w, vpY);
      ctx!.clip();
      ctx!.fillStyle = sunGrad;
      ctx!.fillRect(vpX - 120, vpY - 120, 240, 240);

      // Sun circle with horizontal stripes (synthwave style)
      ctx!.beginPath();
      ctx!.arc(vpX, vpY + 10, 55, Math.PI, 0);
      ctx!.closePath();
      ctx!.fillStyle = `rgba(255, 40, 160, ${working ? 0.85 : 0.55})`;
      ctx!.fill();
      // Stripes across the sun
      for (let s = 1; s <= 5; s++) {
        const sy2 = vpY + 10 - 55 + (s / 6) * 55;
        ctx!.fillStyle = `rgba(${working ? '10, 0, 30' : '5, 0, 20'}, 0.6)`;
        ctx!.fillRect(vpX - 56, sy2, 112, 5);
      }
      ctx!.restore();

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
