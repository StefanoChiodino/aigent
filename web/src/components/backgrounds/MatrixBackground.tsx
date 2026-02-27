import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Matrix — digital rain of characters falling in columns.
 * Idle: slow trickle, dim green. Working: fast rain, bright green + white flash heads.
 */

const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';
const COL_WIDTH = 20;
const FONT_SIZE = 14;

interface Column {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  length: number;
  phase: number;
}

function createColumns(w: number, h: number): Column[] {
  const cols: Column[] = [];
  const count = Math.ceil(w / COL_WIDTH);
  for (let i = 0; i < count; i++) {
    cols.push(makeColumn(i * COL_WIDTH + COL_WIDTH / 2, h));
  }
  return cols;
}

function makeColumn(x: number, h: number): Column {
  const length = 8 + Math.floor(Math.random() * 20);
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(CHARS[Math.floor(Math.random() * CHARS.length)]);
  }
  return {
    x,
    y: -Math.random() * h * 1.5,
    speed: 40 + Math.random() * 80,
    chars,
    length,
    phase: Math.random() * Math.PI * 2,
  };
}

export function MatrixBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const columnsRef = useRef<Column[]>([]);
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
      columnsRef.current = createColumns(window.innerWidth, window.innerHeight);
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
      const columns = columnsRef.current;

      // Fade trail
      ctx!.fillStyle = working ? 'rgba(0, 0, 0, 0.1)' : 'rgba(0, 0, 0, 0.04)';
      ctx!.fillRect(0, 0, w, h);

      const speedMul = working ? 2.5 : 1;
      const baseAlpha = working ? 0.85 : 0.5;

      ctx!.font = `${FONT_SIZE}px monospace`;

      for (const col of columns) {
        col.y += col.speed * speedMul * dt;
        col.phase += dt * 2;

        // Cycle a random char periodically
        if (Math.random() < 0.05) {
          const idx = Math.floor(Math.random() * col.chars.length);
          col.chars[idx] = CHARS[Math.floor(Math.random() * CHARS.length)];
        }

        for (let i = 0; i < col.length; i++) {
          const charY = col.y - i * FONT_SIZE;
          if (charY < -FONT_SIZE || charY > h + FONT_SIZE) continue;

          const fade = 1 - i / col.length;
          const alpha = fade * baseAlpha;

          if (i === 0) {
            // Head — bright white/green
            ctx!.fillStyle = working
              ? `rgba(220, 255, 220, ${alpha * 1.5})`
              : `rgba(150, 255, 150, ${alpha * 1.4})`;
          } else {
            // Body — green
            const g = 200 + fade * 55;
            ctx!.fillStyle = `rgba(0, ${g}, 0, ${alpha})`;
          }

          ctx!.fillText(col.chars[i], col.x, charY);
        }

        // Reset column when fully off screen
        if (col.y - col.length * FONT_SIZE > h) {
          Object.assign(col, makeColumn(col.x, h));
          col.y = -Math.random() * 200;
        }
      }

      animRef.current = requestAnimationFrame(draw);
    }

    // Initial clear
    ctx!.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx!.fillRect(0, 0, canvas!.width, canvas!.height);

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
