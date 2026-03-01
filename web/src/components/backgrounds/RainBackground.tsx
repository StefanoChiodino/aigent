import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Rain — vertical streaks falling from above with splash effects at the bottom.
 * Idle: slow, sparse, dark blue-white. Working: heavy downpour, faster, more splashes.
 */

interface Raindrop {
  x: number;
  y: number;
  speed: number;   // px/sec
  length: number;  // pixels
  alpha: number;
  width: number;
}

interface Splash {
  x: number;
  y: number;
  r: number;       // current radius
  maxR: number;
  life: number;    // 0-1
  alpha: number;
}

function spawnDrop(w: number, h: number, working: boolean): Raindrop {
  return {
    x: Math.random() * (w + 200) - 100,
    y: -50 - Math.random() * h * 0.3,
    speed: (working ? 600 : 300) + Math.random() * (working ? 400 : 200),
    length: (working ? 20 : 10) + Math.random() * (working ? 60 : 30),
    alpha: 0.2 + Math.random() * 0.5,
    width: 0.5 + Math.random() * 1,
  };
}

const SLANT = 0.08; // pixels right per pixel down (slight angle)

export function RainBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const dropsRef = useRef<Raindrop[]>([]);
  const splashesRef = useRef<Splash[]>([]);
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

    let lastTime = 0;
    let spawnAcc = 0;

    // Seed initial drops spread across the screen height
    for (let i = 0; i < 80; i++) {
      const d = spawnDrop(w, h, false);
      d.y = Math.random() * h; // pre-distribute vertically
      dropsRef.current.push(d);
    }

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const drops = dropsRef.current;
      const splashes = splashesRef.current;
      const targetCount = working ? 280 : 90;
      const spawnRate = working ? 200 : 60;

      // Spawn new drops
      spawnAcc += spawnRate * dt;
      while (spawnAcc >= 1 && drops.length < targetCount) {
        drops.push(spawnDrop(w, h, working));
        spawnAcc -= 1;
      }
      spawnAcc = Math.min(spawnAcc, 5);

      // Black transparent wash for trail
      ctx!.fillStyle = 'rgba(5, 10, 20, 0.35)';
      ctx!.fillRect(0, 0, w, h);

      // Draw raindrops
      ctx!.save();
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.y += d.speed * dt;
        d.x += d.speed * SLANT * dt;

        if (d.y - d.length > h) {
          // Splash at bottom
          if (d.y < h + 20) {
            splashes.push({
              x: d.x,
              y: h,
              r: 0,
              maxR: 4 + Math.random() * (working ? 14 : 8),
              life: 0,
              alpha: d.alpha,
            });
          }
          drops.splice(i, 1);
          continue;
        }

        // Drop streak
        const x2 = d.x - d.length * SLANT;
        const y2 = d.y - d.length;
        const grad = ctx!.createLinearGradient(x2, y2, d.x, d.y);
        grad.addColorStop(0, `rgba(150, 200, 255, 0)`);
        grad.addColorStop(1, `rgba(180, 215, 255, ${d.alpha})`);
        ctx!.beginPath();
        ctx!.moveTo(x2, y2);
        ctx!.lineTo(d.x, d.y);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = d.width;
        ctx!.stroke();
      }
      ctx!.restore();

      // Draw splashes (elliptic ripples)
      const splashSpeed = working ? 3.5 : 2.0;
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i];
        s.life += dt * splashSpeed;
        if (s.life >= 1) {
          splashes.splice(i, 1);
          continue;
        }
        s.r = s.maxR * s.life;
        const a = s.alpha * (1 - s.life) * 0.7;
        ctx!.beginPath();
        ctx!.ellipse(s.x, s.y, s.r * 2.5, s.r * 0.6, 0, 0, Math.PI * 2);
        ctx!.strokeStyle = `rgba(160, 210, 255, ${a})`;
        ctx!.lineWidth = 0.8;
        ctx!.stroke();
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
