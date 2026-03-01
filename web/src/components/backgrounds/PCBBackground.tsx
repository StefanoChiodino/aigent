import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * PCB — animated circuit board that builds itself over time.
 *
 * Chips appear one by one (outline → fill → pads → label).
 * Traces grow outward from each chip pad.
 * Bus lanes between chips strengthen as traffic accumulates.
 * Signal pulses travel traces; buses carry dense multi-lane data.
 * Working state floods buses and lights up chip heat overlays.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const GRID = 20;
const CHIP_REVEAL_SEC = 1.8;  // seconds for one chip to fully appear
const TRACE_GROW_SEC  = 1.2;  // seconds for one trace to finish drawing
const CHIP_INTERVAL   = 2.2;  // seconds between chip reveals
const TRACE_INTERVAL  = 0.35; // seconds between trace growth starts

function snap(v: number) { return Math.round(v / GRID) * GRID; }

// ─── Types ───────────────────────────────────────────────────────────────────

interface Pad { x: number; y: number; side: 'T'|'B'|'L'|'R'; }

interface Chip {
  x: number; y: number; w: number; h: number;
  label: string;
  pads: Pad[];
  revealStart: number;   // elapsed time when reveal began
  revealDone: boolean;
  heatLevel: number;
  heatTarget: number;
  blinkPhase: number;
  activity: number;      // 0-1 cumulative signal traffic
}

interface TracePoint { x: number; y: number; }

interface Trace {
  points: TracePoint[];
  totalLen: number;
  width: number;
  isBus: boolean;
  fromChip: number;   // chip index (-1 if free-floating)
  toChip: number;
  growStart: number;  // elapsed time when growth began
  growDone: boolean;
  drawnFrac: number;  // 0-1
  traffic: number;    // cumulative signal count (strengthens bus visually)
}

interface Signal {
  traceIdx: number;
  progress: number;
  speed: number;
  hue: number;
  trail: number;    // trail length as fraction of trace
  reverse: boolean; // direction of travel
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function segLengths(pts: TracePoint[]): number[] {
  const lens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
    lens.push(Math.sqrt(dx*dx + dy*dy));
  }
  return lens;
}

function totalLen(lens: number[]) { return lens.reduce((a, b) => a + b, 0); }

function pointAt(pts: TracePoint[], lens: number[], t: number): TracePoint {
  const tot = totalLen(lens);
  let rem = t * tot;
  for (let i = 0; i < lens.length; i++) {
    if (rem <= lens[i] || i === lens.length - 1) {
      const f = lens[i] > 0 ? rem / lens[i] : 0;
      return { x: pts[i].x + (pts[i+1].x - pts[i].x) * f,
               y: pts[i].y + (pts[i+1].y - pts[i].y) * f };
    }
    rem -= lens[i];
  }
  return pts[pts.length - 1];
}

/** Draw the portion of a polyline from fraction t0 to t1 */
function strokeFrac(
  ctx: CanvasRenderingContext2D,
  pts: TracePoint[], lens: number[],
  t0: number, t1: number,
) {
  if (t1 <= t0) return;
  const tot = totalLen(lens);
  let accFrac = 0;
  let started = false;
  for (let i = 0; i < lens.length; i++) {
    const segFrac = lens[i] / tot;
    const segT0 = accFrac;
    const segT1 = accFrac + segFrac;
    if (segT1 <= t0 || segT0 >= t1) { accFrac = segT1; continue; }
    const enter = Math.max(t0, segT0);
    const exit  = Math.min(t1, segT1);
    const fEnter = segFrac > 0 ? (enter - segT0) / segFrac : 0;
    const fExit  = segFrac > 0 ? (exit  - segT0) / segFrac : 1;
    const ex = pts[i].x + (pts[i+1].x - pts[i].x) * fEnter;
    const ey = pts[i].y + (pts[i+1].y - pts[i].y) * fEnter;
    const fx = pts[i].x + (pts[i+1].x - pts[i].x) * fExit;
    const fy = pts[i].y + (pts[i+1].y - pts[i].y) * fExit;
    if (!started) { ctx.moveTo(ex, ey); started = true; }
    ctx.lineTo(fx, fy);
    accFrac = segT1;
  }
}

// ─── Layout generation ────────────────────────────────────────────────────────

const CHIP_DEFS: Array<{ label: string; cols: number; rows: number }> = [
  { label: 'CPU',  cols: 7, rows: 6 },
  { label: 'GPU',  cols: 6, rows: 5 },
  { label: 'RAM',  cols: 5, rows: 4 },
  { label: 'PCH',  cols: 4, rows: 3 },
  { label: 'BIOS', cols: 3, rows: 3 },
  { label: 'VRM',  cols: 3, rows: 2 },
  { label: 'NIC',  cols: 3, rows: 2 },
  { label: 'SSD',  cols: 4, rows: 3 },
  { label: 'USB',  cols: 3, rows: 2 },
  { label: 'CLK',  cols: 2, rows: 2 },
  { label: 'PWR',  cols: 3, rows: 2 },
  { label: 'DMA',  cols: 3, rows: 2 },
];

const PAD_SPACING = GRID * 2;

function buildPads(cx: number, cy: number, cw: number, ch: number): Pad[] {
  const pads: Pad[] = [];
  for (let px = PAD_SPACING; px < cw - PAD_SPACING / 2; px += PAD_SPACING) {
    pads.push({ x: snap(cx + px), y: snap(cy),      side: 'T' });
    pads.push({ x: snap(cx + px), y: snap(cy + ch), side: 'B' });
  }
  for (let py = PAD_SPACING; py < ch - PAD_SPACING / 2; py += PAD_SPACING) {
    pads.push({ x: snap(cx),      y: snap(cy + py), side: 'L' });
    pads.push({ x: snap(cx + cw), y: snap(cy + py), side: 'R' });
  }
  return pads;
}

function buildBoard(w: number, h: number): { chips: Chip[]; traces: Trace[] } {
  const chips: Chip[] = [];
  const margin = GRID * 4;
  const cellW = Math.floor((w - margin * 2) / 4);
  const cellH = Math.floor((h - margin * 2) / 3);

  // 4×3 grid layout
  for (let i = 0; i < CHIP_DEFS.length && i < 12; i++) {
    const def = CHIP_DEFS[i];
    const col = i % 4;
    const row = Math.floor(i / 4);
    const cw = snap(def.cols * GRID * 1.8);
    const ch = snap(def.rows * GRID * 1.8);
    const cx = snap(margin + col * cellW + (cellW - cw) / 2 + (Math.random() - 0.5) * GRID * 2);
    const cy = snap(margin + row * cellH + (cellH - ch) / 2 + (Math.random() - 0.5) * GRID * 2);
    chips.push({
      x: cx, y: cy, w: cw, h: ch,
      label: def.label,
      pads: buildPads(cx, cy, cw, ch),
      revealStart: -1,
      revealDone: false,
      heatLevel: 0, heatTarget: 0,
      blinkPhase: Math.random() * Math.PI * 2,
      activity: 0,
    });
  }

  // Build traces: inter-chip L-routes + global bus rails
  const traces: Trace[] = [];
  const busLanes: [number, number][] = []; // chip index pairs

  // Connect each chip to its neighbours
  const connections: Set<string> = new Set();
  for (let ci = 0; ci < chips.length; ci++) {
    const c = chips[ci];
    // Connect to 2-3 neighbours (nearby chips)
    const neighbours = chips
      .map((ch, idx) => ({ idx, dist: Math.hypot(ch.x - c.x, ch.y - c.y) }))
      .filter(n => n.idx !== ci)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);

    for (const nb of neighbours) {
      const key = [Math.min(ci, nb.idx), Math.max(ci, nb.idx)].join('-');
      if (connections.has(key)) continue;
      connections.add(key);

      const other = chips[nb.idx];
      // Pick closest pads from each chip
      const cPads = c.pads.filter(p => p.side === 'R' || p.side === 'B');
      const oPads = other.pads.filter(p => p.side === 'L' || p.side === 'T');
      if (cPads.length === 0 || oPads.length === 0) continue;

      // Bus lane: 3 parallel traces, staggered
      const laneCount = Math.floor(Math.random() * 2) + 2; // 2-3 lanes
      for (let lane = 0; lane < laneCount; lane++) {
        const sp = cPads[Math.min(lane, cPads.length - 1)];
        const ep = oPads[Math.min(lane, oPads.length - 1)];
        const sx = snap(sp.x), sy = snap(sp.y);
        const ex = snap(ep.x), ey = snap(ep.y);
        const midX = snap((sx + ex) / 2 + (lane - 1) * GRID);
        const pts = [{ x: sx, y: sy }, { x: midX, y: sy }, { x: midX, y: ey }, { x: ex, y: ey }];
        const lens = segLengths(pts);
        traces.push({
          points: pts, totalLen: totalLen(lens),
          width: 2.5, isBus: true,
          fromChip: ci, toChip: nb.idx,
          growStart: -1, growDone: false, drawnFrac: 0,
          traffic: 0,
        });
      }
      busLanes.push([ci, nb.idx]);

      // A few thinner stub traces off each chip
      for (let s = 0; s < 2; s++) {
        const pad = c.pads[Math.floor(Math.random() * c.pads.length)];
        const sx = snap(pad.x), sy = snap(pad.y);
        const stubLen = GRID * (3 + Math.floor(Math.random() * 6));
        const horiz = pad.side === 'T' || pad.side === 'B';
        const ex = horiz ? sx + (Math.random() < 0.5 ? stubLen : -stubLen) : sx;
        const ey = !horiz ? sy + (Math.random() < 0.5 ? stubLen : -stubLen) : sy;
        const pts = [{ x: sx, y: sy }, { x: snap(ex), y: snap(ey) }];
        const lens = segLengths(pts);
        traces.push({
          points: pts, totalLen: totalLen(lens),
          width: 1.2, isBus: false,
          fromChip: ci, toChip: -1,
          growStart: -1, growDone: false, drawnFrac: 0,
          traffic: 0,
        });
      }
    }
  }

  // Global power/ground horizontal bus rails
  const railY = [
    margin / 2,
    Math.round(h * 0.33),
    Math.round(h * 0.67),
    h - margin / 2,
  ].map(y => snap(y));

  for (const ry of railY) {
    const pts = [{ x: margin, y: ry }, { x: w - margin, y: ry }];
    const lens = segLengths(pts);
    traces.push({
      points: pts, totalLen: totalLen(lens),
      width: 3.5, isBus: true,
      fromChip: -1, toChip: -1,
      growStart: -1, growDone: false, drawnFrac: 0,
      traffic: 0,
    });
  }

  return { chips, traces };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PCBBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const chipsRef = useRef<Chip[]>([]);
  const tracesRef = useRef<Trace[]>([]);
  const signalsRef = useRef<Signal[]>([]);
  const elapsedRef = useRef(0);
  const nextChipTimeRef = useRef(0);
  const nextTraceTimeRef = useRef(CHIP_INTERVAL * 0.5); // traces start appearing mid first chip
  const isWorking = useUIStore(s => s.isLoading);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = window.innerWidth, h = window.innerHeight;

    function rebuild() {
      w = window.innerWidth; h = window.innerHeight;
      const board = buildBoard(w, h);
      chipsRef.current = board.chips;
      tracesRef.current = board.traces;
      signalsRef.current = [];
      elapsedRef.current = 0;
      nextChipTimeRef.current = 0;
      nextTraceTimeRef.current = CHIP_INTERVAL * 0.5;
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = window.innerWidth * dpr;
      canvas!.height = window.innerHeight * dpr;
      canvas!.style.width = window.innerWidth + 'px';
      canvas!.style.height = window.innerHeight + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuild();
    }

    resize();
    window.addEventListener('resize', resize);

    let lastTime = 0;

    // ── Chip drawing ──────────────────────────────────────────────────────────

    function drawChip(chip: Chip, t: number, working: boolean) {
      const elapsed = t - chip.revealStart;
      const frac = Math.min(elapsed / CHIP_REVEAL_SEC, 1);
      if (frac <= 0) return;

      const heat = chip.heatLevel;
      const activity = Math.min(chip.activity, 1);

      // Substrate/shadow
      if (frac > 0.1) {
        ctx!.fillStyle = `rgba(5, 15, 8, ${frac * 0.95})`;
        ctx!.fillRect(chip.x + 2, chip.y + 2, chip.w, chip.h);
      }

      // Body fill — fades in after outline
      const bodyFrac = Math.max(0, (frac - 0.2) / 0.8);
      if (bodyFrac > 0) {
        ctx!.fillStyle = `rgba(${14 + working ? 8 : 0}, ${22 + working ? 10 : 0}, 14, ${bodyFrac * 0.95})`;
        ctx!.fillRect(chip.x, chip.y, chip.w, chip.h);

        // Heat overlay
        if (heat > 0.05) {
          const hg = ctx!.createRadialGradient(
            chip.x + chip.w/2, chip.y + chip.h/2, 0,
            chip.x + chip.w/2, chip.y + chip.h/2, Math.max(chip.w, chip.h) * 0.8,
          );
          hg.addColorStop(0, `rgba(255, 140, 0, ${heat * 0.25})`);
          hg.addColorStop(0.5, `rgba(255, 60, 0, ${heat * 0.12})`);
          hg.addColorStop(1, 'rgba(255, 0, 0, 0)');
          ctx!.fillStyle = hg;
          ctx!.fillRect(chip.x, chip.y, chip.w, chip.h);
        }

        // Activity glow (green, dims to nothing when idle)
        if (activity > 0.05) {
          const ag = ctx!.createRadialGradient(
            chip.x + chip.w/2, chip.y + chip.h/2, 0,
            chip.x + chip.w/2, chip.y + chip.h/2, Math.max(chip.w, chip.h) * 0.6,
          );
          ag.addColorStop(0, `rgba(60, 220, 80, ${activity * 0.12})`);
          ag.addColorStop(1, 'rgba(60, 220, 80, 0)');
          ctx!.fillStyle = ag;
          ctx!.fillRect(chip.x, chip.y, chip.w, chip.h);
        }

        // Silk-screen internal lines
        ctx!.strokeStyle = `rgba(40, 130, 55, ${bodyFrac * 0.12})`;
        ctx!.lineWidth = 0.5;
        const nLines = Math.floor(chip.h / 14);
        for (let li = 1; li < nLines; li++) {
          const ly = chip.y + (li / nLines) * chip.h;
          ctx!.beginPath(); ctx!.moveTo(chip.x + 4, ly); ctx!.lineTo(chip.x + chip.w - 4, ly); ctx!.stroke();
        }
      }

      // Body outline — appears at frac 0, dims after body fills in
      const outlineAlpha = frac < 0.2 ? frac / 0.2 : (0.4 + heat * 0.35 + activity * 0.2);
      ctx!.strokeStyle = `rgba(60, ${working ? 210 : 160}, 75, ${outlineAlpha})`;
      ctx!.lineWidth = 1.5;
      ctx!.beginPath(); ctx!.rect(chip.x, chip.y, chip.w, chip.h); ctx!.stroke();

      // Pin-1 notch
      if (bodyFrac > 0.3) {
        ctx!.beginPath();
        ctx!.arc(chip.x + 8, chip.y + 8, 5, 0, Math.PI * 2);
        ctx!.strokeStyle = `rgba(80, 210, 90, ${bodyFrac * 0.5})`;
        ctx!.lineWidth = 1;
        ctx!.stroke();
      }

      // Label — appears last
      const labelFrac = Math.max(0, (frac - 0.6) / 0.4);
      if (labelFrac > 0) {
        const fontSize = Math.max(9, Math.min(15, chip.w / 5.5));
        ctx!.font = `bold ${fontSize}px monospace`;
        ctx!.textAlign = 'center';
        ctx!.textBaseline = 'middle';
        ctx!.globalAlpha = labelFrac;
        ctx!.fillStyle = `rgba(80, ${working ? 230 : 190}, 100, ${0.65 + heat * 0.3})`;
        ctx!.fillText(chip.label, chip.x + chip.w / 2, chip.y + chip.h / 2);
        ctx!.globalAlpha = 1;
      }

      // Pads — appear with body
      if (bodyFrac > 0.1) {
        for (const pad of chip.pads) {
          ctx!.beginPath();
          ctx!.rect(pad.x - 3, pad.y - 3, 6, 6);
          ctx!.fillStyle = `rgba(170, 195, 150, ${bodyFrac * 0.55})`;
          ctx!.fill();
          ctx!.strokeStyle = `rgba(60, 200, 75, ${bodyFrac * 0.4})`;
          ctx!.lineWidth = 0.5;
          ctx!.stroke();
        }
      }

      // Blink LED
      if (frac >= 1) {
        chip.blinkPhase += working ? 0.06 : 0.02;
        const blinkOn = working ? (Math.sin(chip.blinkPhase * (3 + heat * 5)) + 1) / 2 : 0.12;
        ctx!.beginPath();
        ctx!.arc(chip.x + chip.w - 7, chip.y + 7, 2.5, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(0, 255, 80, ${blinkOn * 0.95})`;
        ctx!.fill();
      }
    }

    // ── Trace drawing ─────────────────────────────────────────────────────────

    function drawTrace(trace: Trace, t: number, working: boolean) {
      if (trace.growStart < 0) return;

      // Grow drawn fraction
      if (!trace.growDone) {
        const elapsed = t - trace.growStart;
        trace.drawnFrac = Math.min(elapsed / TRACE_GROW_SEC, 1);
        if (trace.drawnFrac >= 1) trace.growDone = true;
      }

      const frac = trace.drawnFrac;
      if (frac <= 0) return;

      const pts = trace.points;
      const lens = segLengths(pts);

      // Traffic-based brightness (bus strengthens with use)
      const trafficBright = Math.min(trace.traffic / 30, 1);
      const busBoost = trace.isBus ? 0.12 + trafficBright * 0.18 : 0;
      const baseAlpha = (working ? 0.18 : 0.08) + busBoost;

      // Draw the trace up to drawnFrac
      ctx!.beginPath();
      strokeFrac(ctx!, pts, lens, 0, frac);
      ctx!.strokeStyle = `rgba(40, ${trace.isBus ? 180 : 150}, 60, ${baseAlpha})`;
      ctx!.lineWidth = trace.width + trafficBright * (trace.isBus ? 1.5 : 0.5);
      ctx!.lineCap = 'square';
      ctx!.lineJoin = 'miter';
      ctx!.stroke();

      // Bus glow layer
      if (trace.isBus && (trafficBright > 0.1 || working)) {
        const glowAlpha = (working ? 0.12 : 0.04) + trafficBright * 0.14;
        ctx!.beginPath();
        strokeFrac(ctx!, pts, lens, 0, frac);
        ctx!.strokeStyle = `rgba(60, 220, 80, ${glowAlpha})`;
        ctx!.lineWidth = trace.width + 4 + trafficBright * 3;
        ctx!.stroke();
      }

      // Growing-edge spark: bright dot at the tip as trace draws in
      if (!trace.growDone && frac > 0) {
        const tip = pointAt(pts, lens, frac);
        const sparkR = 6;
        const sg = ctx!.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, sparkR);
        sg.addColorStop(0, 'rgba(160, 255, 160, 0.9)');
        sg.addColorStop(1, 'rgba(60, 220, 80, 0)');
        ctx!.fillStyle = sg;
        ctx!.fillRect(tip.x - sparkR, tip.y - sparkR, sparkR*2, sparkR*2);
      }

      // Endpoint vias
      if (frac >= 1) {
        for (const pt of [pts[0], pts[pts.length - 1]]) {
          const vr = trace.width + 2;
          ctx!.beginPath(); ctx!.arc(pt.x, pt.y, vr, 0, Math.PI * 2);
          ctx!.fillStyle = `rgba(60, 190, 70, ${0.25 + trafficBright * 0.2})`;
          ctx!.fill();
          ctx!.beginPath(); ctx!.arc(pt.x, pt.y, vr * 0.45, 0, Math.PI * 2);
          ctx!.fillStyle = 'rgba(3, 12, 5, 0.9)';
          ctx!.fill();
        }
      }
    }

    // ── Signal drawing ────────────────────────────────────────────────────────

    function drawSignal(sig: Signal, traces: Trace[], working: boolean) {
      const trace = traces[sig.traceIdx];
      if (!trace.growDone) return;

      const pts = trace.points;
      const lens = segLengths(pts);

      const headT = sig.reverse ? 1 - sig.progress : sig.progress;
      const tailT = sig.reverse ? Math.min(1, headT + sig.trail) : Math.max(0, headT - sig.trail);
      const t0 = Math.min(headT, tailT);
      const t1 = Math.max(headT, tailT);
      const head = pointAt(pts, lens, headT);

      const alpha = working ? 0.95 : 0.65;
      const from = pointAt(pts, lens, t0);
      const to   = pointAt(pts, lens, t1);
      const grad = ctx!.createLinearGradient(from.x, from.y, to.x, to.y);
      grad.addColorStop(0, `hsla(${sig.hue}, 100%, 65%, 0)`);
      grad.addColorStop(0.7, `hsla(${sig.hue}, 100%, 72%, ${alpha * 0.5})`);
      grad.addColorStop(1, `hsla(${sig.hue}, 100%, 88%, ${alpha})`);

      ctx!.beginPath();
      strokeFrac(ctx!, pts, lens, t0, t1);
      ctx!.strokeStyle = grad;
      ctx!.lineWidth = trace.width + (working ? 2.5 : 1.5);
      ctx!.lineCap = 'round';
      ctx!.stroke();

      // Head glow
      const gr = working ? 10 : 6;
      const hg = ctx!.createRadialGradient(head.x, head.y, 0, head.x, head.y, gr);
      hg.addColorStop(0, `hsla(${sig.hue}, 100%, 90%, ${alpha})`);
      hg.addColorStop(1, `hsla(${sig.hue}, 100%, 70%, 0)`);
      ctx!.fillStyle = hg;
      ctx!.fillRect(head.x - gr, head.y - gr, gr*2, gr*2);
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;
      elapsedRef.current += dt;
      const t = elapsedRef.current;

      const working = isWorkingRef.current;
      const chips = chipsRef.current;
      const traces = tracesRef.current;
      const signals = signalsRef.current;

      // ── Substrate background ────────────────────────────────────────────────
      ctx!.fillStyle = working ? 'rgb(7, 17, 9)' : 'rgb(5, 12, 6)';
      ctx!.fillRect(0, 0, w, h);

      // Routing grid dots
      ctx!.fillStyle = `rgba(0, 50, 10, ${working ? 0.45 : 0.28})`;
      for (let gx = 0; gx < w; gx += GRID) {
        for (let gy = 0; gy < h; gy += GRID) {
          ctx!.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }

      // Board edge
      const em = GRID * 2;
      ctx!.strokeStyle = `rgba(50, 190, 65, ${working ? 0.28 : 0.14})`;
      ctx!.lineWidth = 2;
      ctx!.beginPath(); ctx!.rect(em, em, w - em*2, h - em*2); ctx!.stroke();
      // Mounting holes
      for (const [hx, hy] of [[em+14,em+14],[w-em-14,em+14],[em+14,h-em-14],[w-em-14,h-em-14]]) {
        ctx!.beginPath(); ctx!.arc(hx, hy, 5, 0, Math.PI*2);
        ctx!.strokeStyle = `rgba(50, 190, 65, ${working ? 0.35 : 0.18})`; ctx!.lineWidth = 1.5; ctx!.stroke();
        ctx!.beginPath(); ctx!.arc(hx, hy, 2, 0, Math.PI*2);
        ctx!.fillStyle = 'rgba(2, 8, 3, 1)'; ctx!.fill();
      }

      // ── Reveal chips over time ─────────────────────────────────────────────
      const pendingChips = chips.filter(c => !c.revealDone && c.revealStart < 0);
      if (pendingChips.length > 0 && t >= nextChipTimeRef.current) {
        pendingChips[0].revealStart = t;
        nextChipTimeRef.current = t + (working ? CHIP_INTERVAL * 0.4 : CHIP_INTERVAL);
      }
      // Mark chip as fully revealed
      for (const chip of chips) {
        if (chip.revealStart >= 0 && !chip.revealDone) {
          if (t - chip.revealStart >= CHIP_REVEAL_SEC) chip.revealDone = true;
        }
      }

      // ── Reveal traces over time ────────────────────────────────────────────
      const pendingTraces = traces.filter(tr => tr.growStart < 0);
      if (pendingTraces.length > 0 && t >= nextTraceTimeRef.current) {
        // Prefer traces connecting revealed chips
        const ready = pendingTraces.filter(tr =>
          (tr.fromChip < 0 || chips[tr.fromChip]?.revealStart >= 0) &&
          (tr.toChip < 0   || chips[tr.toChip]?.revealStart >= 0),
        );
        const pick = ready.length > 0 ? ready[Math.floor(Math.random() * ready.length)] : pendingTraces[0];
        pick.growStart = t;
        nextTraceTimeRef.current = t + (working ? TRACE_INTERVAL * 0.3 : TRACE_INTERVAL);
      }

      // ── Draw traces ────────────────────────────────────────────────────────
      for (const trace of traces) drawTrace(trace, t, working);

      // ── Draw chips ─────────────────────────────────────────────────────────
      for (const chip of chips) {
        if (chip.revealStart < 0) continue;
        // Update heat
        if (working) {
          chip.heatTarget = 0.2 + chip.activity * 0.8;
          chip.heatLevel += (chip.heatTarget - chip.heatLevel) * dt * 1.2;
        } else {
          chip.heatLevel *= 0.97;
          chip.activity *= 0.995;
        }
        drawChip(chip, t, working);
      }

      // ── Spawn signals ──────────────────────────────────────────────────────
      const readyTraces = traces.filter(tr => tr.growDone);
      const maxSignals = working ? 80 : 20;
      const spawnRate = working ? 12 : 2;
      if (readyTraces.length > 0 && signals.length < maxSignals && Math.random() < spawnRate * dt) {
        // Bias toward bus traces between revealed chips
        const busTraces = readyTraces.filter(tr => tr.isBus && tr.fromChip >= 0 && tr.toChip >= 0);
        const pool = busTraces.length > 0 && Math.random() < 0.75 ? busTraces : readyTraces;
        const picked = pool[Math.floor(Math.random() * pool.length)];
        const traceIdx = traces.indexOf(picked);

        signals.push({
          traceIdx,
          progress: 0,
          speed: (working ? 0.5 : 0.2) + Math.random() * 0.3,
          hue: picked.isBus ? (working ? 80 + Math.random() * 50 : 110 + Math.random() * 30) : 140 + Math.random() * 20,
          trail: picked.isBus ? 0.15 + Math.random() * 0.15 : 0.08 + Math.random() * 0.08,
          reverse: Math.random() < 0.5,
        });
      }

      // ── Update and draw signals ────────────────────────────────────────────
      for (let i = signals.length - 1; i >= 0; i--) {
        const sig = signals[i];
        sig.progress += sig.speed * dt;

        if (sig.progress > 1 + sig.trail) {
          // Signal arrived — credit chips and trace
          const trace = traces[sig.traceIdx];
          trace.traffic = Math.min(trace.traffic + 1, 100);
          const fromC = trace.fromChip >= 0 ? chips[trace.fromChip] : null;
          const toC   = trace.toChip   >= 0 ? chips[trace.toChip]   : null;
          if (fromC) fromC.activity = Math.min(fromC.activity + 0.04, 1);
          if (toC)   toC.activity   = Math.min(toC.activity   + 0.04, 1);
          signals.splice(i, 1);
          continue;
        }

        drawSignal(sig, traces, working);
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(animRef.current); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="theme-canvas-bg"
      aria-hidden="true"
    />
  );
}
