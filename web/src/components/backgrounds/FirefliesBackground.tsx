import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Fireflies — glowing dots that drift organically through the dark, pulsing softly.
 * Idle: sparse, warm yellow-green drifters. Working: denser, brighter, faster, with blue-white flashes.
 */

interface Firefly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetVx: number;
  targetVy: number;
  phase: number;       // pulse phase
  pulseSpeed: number;
  radius: number;
  hue: number;         // 55-100 warm yellows/greens
  steerTimer: number;  // seconds until next direction change
}

function spawnFirefly(w: number, h: number): Firefly {
  const angle = Math.random() * Math.PI * 2;
  const speed = 10 + Math.random() * 20;
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    targetVx: Math.cos(angle) * speed,
    targetVy: Math.sin(angle) * speed,
    phase: Math.random() * Math.PI * 2,
    pulseSpeed: 0.6 + Math.random() * 1.2,
    radius: 1.5 + Math.random() * 2,
    hue: 55 + Math.random() * 45,
    steerTimer: 0.5 + Math.random() * 2,
  };
}

const MAX_IDLE = 60;
const MAX_WORKING = 140;

export function FirefliesBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const firefliesRef = useRef<Firefly[]>([]);
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

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const flies = firefliesRef.current;
      const target = working ? MAX_WORKING : MAX_IDLE;

      // Spawn / trim
      while (flies.length < target) flies.push(spawnFirefly(w, h));
      if (flies.length > target + 10) flies.splice(target + 10);

      // Fade trail
      ctx!.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx!.fillRect(0, 0, w, h);

      for (const f of flies) {
        f.phase += f.pulseSpeed * dt;
        f.steerTimer -= dt;

        if (f.steerTimer <= 0) {
          const angle = Math.random() * Math.PI * 2;
          const speed = (working ? 20 : 10) + Math.random() * 20;
          f.targetVx = Math.cos(angle) * speed;
          f.targetVy = Math.sin(angle) * speed;
          f.steerTimer = 0.8 + Math.random() * (working ? 1.5 : 3.0);
        }

        // Smooth steering
        const steer = 2.5 * dt;
        f.vx += (f.targetVx - f.vx) * steer;
        f.vy += (f.targetVy - f.vy) * steer;

        f.x += f.vx * dt;
        f.y += f.vy * dt;

        // Wrap around edges
        if (f.x < -20) f.x = w + 20;
        if (f.x > w + 20) f.x = -20;
        if (f.y < -20) f.y = h + 20;
        if (f.y > h + 20) f.y = -20;

        // Pulse brightness
        const pulse = (Math.sin(f.phase) + 1) / 2; // 0-1
        const alpha = working
          ? 0.5 + pulse * 0.5
          : 0.2 + pulse * 0.5;

        // Hue shift: working fireflies flash blue-white briefly at peak
        const displayHue = working && pulse > 0.9 ? 200 : f.hue;
        const r = f.radius + pulse * 1.5;
        const glowR = r * (working ? 18 : 14);

        // Outer glow
        const grad = ctx!.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR);
        grad.addColorStop(0, `hsla(${displayHue}, 100%, 72%, ${alpha * 0.55})`);
        grad.addColorStop(0.35, `hsla(${displayHue}, 100%, 65%, ${alpha * 0.18})`);
        grad.addColorStop(1, `hsla(${displayHue}, 100%, 60%, 0)`);
        ctx!.fillStyle = grad;
        ctx!.fillRect(f.x - glowR, f.y - glowR, glowR * 2, glowR * 2);

        // Bright core
        ctx!.beginPath();
        ctx!.arc(f.x, f.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = `hsla(${displayHue}, 80%, 90%, ${alpha})`;
        ctx!.fill();
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
