import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Constellation — slowly drifting stars with proximity-based connection lines.
 * Stars twinkle gently. When working, stars drift faster and connections glow brighter.
 * Warm white / pale gold palette against deep space.
 */

interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  brightness: number;
  phase: number;
  twinkleSpeed: number;
}

function createStars(w: number, h: number): Star[] {
  const count = Math.floor((w * h) / 8000);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 8,
      radius: 0.5 + Math.random() * 2,
      brightness: 0.3 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.5 + Math.random() * 2,
    });
  }
  return stars;
}

export function ConstellationBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const starsRef = useRef<Star[]>([]);
  const isWorking = useUIStore(s => s.isLoading);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = window.innerWidth * dpr;
      canvas!.height = window.innerHeight * dpr;
      canvas!.style.width = window.innerWidth + 'px';
      canvas!.style.height = window.innerHeight + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      starsRef.current = createStars(window.innerWidth, window.innerHeight);
    }

    resize();
    window.addEventListener('resize', resize);

    let lastTime = 0;

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;
      const stars = starsRef.current;

      ctx!.clearRect(0, 0, w, h);

      const speedMul = working ? 3 : 1;
      const connectDist = working ? 160 : 120;

      // Update positions
      for (const star of stars) {
        star.x += star.vx * speedMul * dt;
        star.y += star.vy * speedMul * dt;
        star.phase += star.twinkleSpeed * dt;

        // Wrap around edges
        if (star.x < -10) star.x = w + 10;
        if (star.x > w + 10) star.x = -10;
        if (star.y < -10) star.y = h + 10;
        if (star.y > h + 10) star.y = -10;
      }

      // Draw connections
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const dx = stars[i].x - stars[j].x;
          const dy = stars[i].y - stars[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > connectDist) continue;

          const falloff = 1 - dist / connectDist;
          const alpha = falloff * (working ? 0.4 : 0.2);

          ctx!.beginPath();
          ctx!.moveTo(stars[i].x, stars[i].y);
          ctx!.lineTo(stars[j].x, stars[j].y);
          ctx!.strokeStyle = `rgba(200, 200, 240, ${alpha})`;
          ctx!.lineWidth = falloff * 0.8;
          ctx!.stroke();
        }
      }

      // Draw stars
      for (const star of stars) {
        const twinkle = (Math.sin(star.phase) * 0.5 + 0.5);
        const alpha = star.brightness * (0.5 + twinkle * 0.5) * (working ? 1.4 : 1.0);

        // Glow
        const glowR = star.radius * (working ? 8 : 5);
        const grad = ctx!.createRadialGradient(star.x, star.y, 0, star.x, star.y, glowR);
        grad.addColorStop(0, `rgba(220, 220, 255, ${alpha * 0.6})`);
        grad.addColorStop(1, 'rgba(220, 220, 255, 0)');
        ctx!.fillStyle = grad;
        ctx!.fillRect(star.x - glowR, star.y - glowR, glowR * 2, glowR * 2);

        // Core
        ctx!.beginPath();
        ctx!.arc(star.x, star.y, star.radius * (0.6 + twinkle * 0.4), 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(240, 240, 255, ${alpha})`;
        ctx!.fill();
      }

      // Occasional shooting star when working
      if (working) {
        const shootChance = Math.sin(time * 0.0007) * 0.5 + 0.5;
        if (shootChance > 0.97) {
          const sx = Math.random() * w;
          const sy = Math.random() * h * 0.4;
          const len = 60 + Math.random() * 100;
          const angle = Math.PI * 0.15 + Math.random() * 0.2;
          const grad = ctx!.createLinearGradient(sx, sy, sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
          grad.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
          grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx!.beginPath();
          ctx!.moveTo(sx, sy);
          ctx!.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
          ctx!.strokeStyle = grad;
          ctx!.lineWidth = 1.5;
          ctx!.stroke();
        }
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
