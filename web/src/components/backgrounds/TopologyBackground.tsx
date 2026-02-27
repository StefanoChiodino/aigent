import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Topology — animated contour-map lines that shift like a living terrain.
 * Uses Perlin-ish noise rendered as isolines. Idle: slow morph, muted teal.
 * Working: faster evolution, brighter lines with warm accent highlights.
 */

// Simple 2D value noise (good enough for contour lines)
const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  PERM.set(p);
  PERM.set(p, 256);
}

function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a: number, b: number, t: number) { return a + t * (b - a); }
function grad(hash: number, x: number, y: number): number {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

function noise(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];

  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
    v,
  );
}

function fbm(x: number, y: number, octaves: number): number {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

const CONTOUR_LEVELS = 10;
const CELL = 6; // resolution of the scalar field grid

export function TopologyBackground() {
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

    function draw(time: number) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const working = isWorkingRef.current;

      ctx!.clearRect(0, 0, w, h);

      const t = time * (working ? 0.00025 : 0.00008);
      const scale = 0.008;
      const cols = Math.ceil(w / CELL) + 1;
      const rows = Math.ceil(h / CELL) + 1;

      // Build scalar field
      const field = new Float32Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          field[r * cols + c] = fbm(c * CELL * scale + t, r * CELL * scale + t * 0.7, 4);
        }
      }

      // Marching squares — draw line segments for each contour level
      const baseAlpha = working ? 0.5 : 0.28;

      for (let level = 0; level < CONTOUR_LEVELS; level++) {
        const threshold = -0.5 + (level / CONTOUR_LEVELS);
        const levelFrac = level / CONTOUR_LEVELS;

        // Color varies by level
        const r = Math.round(30 + levelFrac * 40);
        const g = Math.round(180 + levelFrac * 50);
        const b = Math.round(180 - levelFrac * 40);
        const alpha = baseAlpha * (0.5 + levelFrac * 0.5);

        ctx!.strokeStyle = working && level > CONTOUR_LEVELS * 0.7
          ? `rgba(255, ${160 + levelFrac * 60}, 80, ${alpha * 1.3})`
          : `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx!.lineWidth = working ? 1.5 : 1.0;

        ctx!.beginPath();

        for (let row = 0; row < rows - 1; row++) {
          for (let col = 0; col < cols - 1; col++) {
            const tl = field[row * cols + col];
            const tr = field[row * cols + col + 1];
            const bl = field[(row + 1) * cols + col];
            const br = field[(row + 1) * cols + col + 1];

            const x = col * CELL;
            const y = row * CELL;

            // Which corners are above threshold?
            const config =
              (tl > threshold ? 8 : 0) |
              (tr > threshold ? 4 : 0) |
              (br > threshold ? 2 : 0) |
              (bl > threshold ? 1 : 0);

            if (config === 0 || config === 15) continue;

            // Interpolation helpers
            const lerpT = (a: number, b: number) => {
              const d = b - a;
              if (Math.abs(d) < 0.0001) return 0.5;
              return (threshold - a) / d;
            };

            const top = x + lerpT(tl, tr) * CELL;
            const bottom = x + lerpT(bl, br) * CELL;
            const left = y + lerpT(tl, bl) * CELL;
            const right = y + lerpT(tr, br) * CELL;

            const segments: [number, number, number, number][] = [];

            switch (config) {
              case 1: case 14: segments.push([x, left, bottom, y + CELL]); break;
              case 2: case 13: segments.push([bottom, y + CELL, x + CELL, right]); break;
              case 3: case 12: segments.push([x, left, x + CELL, right]); break;
              case 4: case 11: segments.push([top, y, x + CELL, right]); break;
              case 5: segments.push([x, left, top, y]); segments.push([bottom, y + CELL, x + CELL, right]); break;
              case 6: case 9: segments.push([top, y, bottom, y + CELL]); break;
              case 7: case 8: segments.push([x, left, top, y]); break;
              case 10: segments.push([top, y, x + CELL, right]); segments.push([x, left, bottom, y + CELL]); break;
            }

            for (const [x1, y1, x2, y2] of segments) {
              ctx!.moveTo(x1, y1);
              ctx!.lineTo(x2, y2);
            }
          }
        }

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
