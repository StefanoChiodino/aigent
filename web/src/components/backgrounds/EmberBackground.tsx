import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Ember — glowing particles that float upward like embers from a fire.
 * Idle: slow, sparse, warm amber. Working: fast, dense, white-hot cores with red/orange trails.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
  hue: number; // 10-40 range (red → orange → amber)
  brightness: number;
  wobblePhase: number;
  wobbleSpeed: number;
  wobbleAmp: number;
}

function spawnParticle(w: number, h: number, working: boolean): Particle {
  const hue = 10 + Math.random() * 30;
  return {
    x: Math.random() * w,
    y: h + Math.random() * 40,
    vx: (Math.random() - 0.5) * 20,
    vy: -(20 + Math.random() * (working ? 80 : 40)),
    life: 0,
    maxLife: 3 + Math.random() * (working ? 4 : 6),
    radius: 1 + Math.random() * 3,
    hue,
    brightness: 0.5 + Math.random() * 0.5,
    wobblePhase: Math.random() * Math.PI * 2,
    wobbleSpeed: 1 + Math.random() * 3,
    wobbleAmp: 10 + Math.random() * 30,
  };
}

const MAX_PARTICLES = 300;

export function EmberBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
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
    }

    resize();
    window.addEventListener('resize', resize);

    let lastTime = 0;
    let spawnAcc = 0;

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;
      const particles = particlesRef.current;

      ctx!.clearRect(0, 0, w, h);

      // Spawn rate
      const spawnRate = working ? 50 : 15; // particles per second
      spawnAcc += spawnRate * dt;
      while (spawnAcc >= 1 && particles.length < MAX_PARTICLES) {
        particles.push(spawnParticle(w, h, working));
        spawnAcc -= 1;
      }
      spawnAcc = Math.min(spawnAcc, 3);

      // Subtle heat haze at bottom when working
      if (working) {
        const hazeGrad = ctx!.createLinearGradient(0, h, 0, h * 0.6);
        hazeGrad.addColorStop(0, 'rgba(255, 80, 20, 0.03)');
        hazeGrad.addColorStop(1, 'rgba(255, 80, 20, 0)');
        ctx!.fillStyle = hazeGrad;
        ctx!.fillRect(0, h * 0.6, w, h * 0.4);
      }

      // Update and draw particles (iterate backwards for splice)
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;

        if (p.life > p.maxLife) {
          particles.splice(i, 1);
          continue;
        }

        // Physics
        p.wobblePhase += p.wobbleSpeed * dt;
        p.x += p.vx * dt + Math.sin(p.wobblePhase) * p.wobbleAmp * dt;
        p.y += p.vy * dt;
        p.vy *= 0.998; // slight deceleration
        p.vx *= 0.99;

        // Life curve: fade in quickly, fade out slowly
        const lifeFrac = p.life / p.maxLife;
        const fadeIn = Math.min(lifeFrac * 5, 1);
        const fadeOut = 1 - Math.pow(lifeFrac, 2);
        const alpha = fadeIn * fadeOut * p.brightness * (working ? 1.0 : 0.65);

        // Size shrinks over life
        const r = p.radius * (1 - lifeFrac * 0.5);

        // Glow
        const glowR = r * (working ? 12 : 8);
        const grad = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
        const hsl = `hsla(${p.hue}, 100%, ${working ? '75%' : '60%'},`;
        grad.addColorStop(0, `${hsl} ${alpha * 0.6})`);
        grad.addColorStop(0.3, `${hsl} ${alpha * 0.2})`);
        grad.addColorStop(1, `${hsl} 0)`);
        ctx!.fillStyle = grad;
        ctx!.fillRect(p.x - glowR, p.y - glowR, glowR * 2, glowR * 2);

        // Core
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, r, 0, Math.PI * 2);
        // Hot core: more white when young
        const coreLightness = working ? 80 + (1 - lifeFrac) * 20 : 60 + (1 - lifeFrac) * 20;
        ctx!.fillStyle = `hsla(${p.hue}, 90%, ${coreLightness}%, ${alpha * 1.5})`;
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
