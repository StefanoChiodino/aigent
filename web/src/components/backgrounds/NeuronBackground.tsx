import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Neuron — a living neural network with anatomically-styled cells.
 *
 * Each neuron has:
 *   - A multi-layered soma (outer membrane, cytoplasm gradient, nucleus ring, nucleolus)
 *   - Short branching dendrite arms radiating outward (3-6 arms, each with 1-2 sub-branches)
 *   - An axon hillock stub in the direction of each synapse
 *
 * Synapses are drawn as curved Bézier arcs with a synaptic-button terminal.
 * Signals travel the curve with a comet tail + action-potential ring on arrival.
 * Links strengthen with use, fade with disuse, and are pruned when too weak.
 * Thoughts cascade neuron-to-neuron, bouncing back, arriving from screen edges.
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const NEURON_COUNT     = 48;
const MAX_SYNAPSES     = 5;
const CONNECT_RANGE    = 230;
const LINK_FADE_RATE   = 0.005;
const LINK_REINFORCE   = 0.20;
const LINK_FORM_CHANCE = 0.009;
const LINK_PRUNE       = 0.03;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DendriteArm {
  angle: number;      // from soma centre
  len: number;
  wobble: number;     // curvature amount
  branches: Array<{ offset: number; angle: number; len: number }>;
}

interface Neuron {
  x: number; y: number;
  r: number;          // soma radius (8-16)
  dendrites: DendriteArm[];
  phase: number;
  fireLevel: number;  // 0→1, decays
  actionRings: Array<{ r: number; alpha: number }>; // outward ripple rings
  hue: number;        // base hue (per neuron, subtle variation)
}

interface Synapse {
  from: number; to: number;
  strength: number;   // 0-1
  age: number;
  cpDx: number; cpDy: number; // control-point offset for the bezier curve (fixed per synapse)
}

interface Pulse {
  from: number; to: number;
  t: number;
  speed: number;
  hue: number;
  size: number;
  cascadeLeft: number;
}

interface EdgeSignal {
  x: number; y: number;
  tx: number; ty: number;
  t: number; speed: number;
  hue: number;
  toNeuron: number;
  inbound: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function randomEdgePoint(w: number, h: number) {
  const s = Math.floor(Math.random() * 4);
  switch (s) {
    case 0: return { x: Math.random() * w, y: -10 };
    case 1: return { x: Math.random() * w, y: h + 10 };
    case 2: return { x: -10, y: Math.random() * h };
    default: return { x: w + 10, y: Math.random() * h };
  }
}

function findSynapse(synapses: Synapse[], a: number, b: number) {
  return synapses.find(s => (s.from === a && s.to === b) || (s.from === b && s.to === a));
}

function makeDendrites(r: number): DendriteArm[] {
  const count = 3 + Math.floor(Math.random() * 4);
  return Array.from({ length: count }, (_, i) => {
    const baseAngle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const armLen = r * (1.5 + Math.random() * 2.2);
    const branchCount = Math.random() < 0.5 ? 1 : 2;
    return {
      angle: baseAngle,
      len: armLen,
      wobble: (Math.random() - 0.5) * 0.8,
      branches: Array.from({ length: branchCount }, () => ({
        offset: 0.4 + Math.random() * 0.4, // position along arm
        angle: baseAngle + (Math.random() - 0.5) * 1.2,
        len: armLen * (0.3 + Math.random() * 0.4),
      })),
    };
  });
}

// Quadratic bézier point
function bezierPoint(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number,
) {
  const mt = 1 - t;
  return {
    x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
    y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1,
  };
}

// Tangent direction of quadratic bézier at t
function bezierTangent(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number,
) {
  const mt = 1 - t;
  return {
    dx: 2 * mt * (cx - x0) + 2 * t * (x1 - cx),
    dy: 2 * mt * (cy - y0) + 2 * t * (y1 - cy),
  };
}

// ─── Neuron drawing ───────────────────────────────────────────────────────────

function drawNeuron(
  ctx: CanvasRenderingContext2D,
  n: Neuron,
  dt: number,
  working: boolean,
) {
  n.phase += dt * (working ? 1.0 : 0.4);
  n.fireLevel = Math.max(0, n.fireLevel - dt * (working ? 1.8 : 1.0));

  // Update action-potential rings
  for (let ri = n.actionRings.length - 1; ri >= 0; ri--) {
    const ring = n.actionRings[ri];
    ring.r += dt * 80;
    ring.alpha -= dt * 2.2;
    if (ring.alpha <= 0) n.actionRings.splice(ri, 1);
  }

  const fire = n.fireLevel;
  const idle = (Math.sin(n.phase) + 1) / 2;
  const glow = fire > 0 ? fire : idle * 0.1;

  // ── Dendrites ────────────────────────────────────────────────────────────────
  const dendAlpha = 0.18 + glow * 0.35 + (working ? 0.08 : 0);
  ctx.strokeStyle = `hsla(${n.hue}, 70%, 65%, ${dendAlpha})`;
  ctx.lineCap = 'round';

  for (const arm of n.dendrites) {
    const endX = n.x + Math.cos(arm.angle) * arm.len;
    const endY = n.y + Math.sin(arm.angle) * arm.len;
    const cpX  = n.x + Math.cos(arm.angle) * arm.len * 0.5 + Math.cos(arm.angle + Math.PI / 2) * arm.wobble * arm.len * 0.4;
    const cpY  = n.y + Math.sin(arm.angle) * arm.len * 0.5 + Math.sin(arm.angle + Math.PI / 2) * arm.wobble * arm.len * 0.4;

    // Main arm: taper from soma radius to 0.5
    ctx.lineWidth = 1.4 - 0.9 * 0;
    ctx.beginPath();
    ctx.moveTo(n.x + Math.cos(arm.angle) * n.r * 0.85, n.y + Math.sin(arm.angle) * n.r * 0.85);
    ctx.quadraticCurveTo(cpX, cpY, endX, endY);
    ctx.lineWidth = 0.9;
    ctx.stroke();

    // Sub-branches
    for (const br of arm.branches) {
      const bStart = bezierPoint(n.x, n.y, cpX, cpY, endX, endY, br.offset);
      const bEnd = { x: bStart.x + Math.cos(br.angle) * br.len, y: bStart.y + Math.sin(br.angle) * br.len };
      ctx.beginPath();
      ctx.moveTo(bStart.x, bStart.y);
      ctx.lineTo(bEnd.x, bEnd.y);
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Dendritic spine tips (tiny bulbs at branch ends)
      ctx.beginPath();
      ctx.arc(bEnd.x, bEnd.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${n.hue}, 70%, 72%, ${dendAlpha * 1.2})`;
      ctx.fill();
    }

    // Growth cone tip on main arm
    ctx.beginPath();
    ctx.arc(endX, endY, 2, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${n.hue}, 80%, 75%, ${dendAlpha * 1.4})`;
    ctx.fill();
  }

  // ── Action-potential rings ────────────────────────────────────────────────────
  for (const ring of n.actionRings) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, ring.r, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${n.hue + 40}, 100%, 75%, ${ring.alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ── Soma layers ───────────────────────────────────────────────────────────────
  const somaR = n.r + fire * 3;

  // Outer membrane glow (extended aura)
  const auraR = somaR * (4 + glow * 6);
  const aura = ctx.createRadialGradient(n.x, n.y, somaR * 0.5, n.x, n.y, auraR);
  aura.addColorStop(0, `hsla(${n.hue}, 90%, 65%, ${glow * 0.45})`);
  aura.addColorStop(0.4, `hsla(${n.hue}, 80%, 55%, ${glow * 0.15})`);
  aura.addColorStop(1, `hsla(${n.hue}, 80%, 50%, 0)`);
  ctx.fillStyle = aura;
  ctx.fillRect(n.x - auraR, n.y - auraR, auraR * 2, auraR * 2);

  // Outer membrane (cell boundary — slightly translucent fill)
  const memGrad = ctx.createRadialGradient(n.x - somaR * 0.3, n.y - somaR * 0.3, 0, n.x, n.y, somaR);
  memGrad.addColorStop(0, `hsla(${n.hue}, 60%, ${35 + fire * 25}%, 0.65)`);
  memGrad.addColorStop(0.7, `hsla(${n.hue}, 50%, ${20 + fire * 15}%, 0.55)`);
  memGrad.addColorStop(1, `hsla(${n.hue}, 70%, ${40 + fire * 30}%, 0.3)`);
  ctx.beginPath();
  ctx.arc(n.x, n.y, somaR, 0, Math.PI * 2);
  ctx.fillStyle = memGrad;
  ctx.fill();

  // Membrane outline ring
  ctx.beginPath();
  ctx.arc(n.x, n.y, somaR, 0, Math.PI * 2);
  ctx.strokeStyle = `hsla(${n.hue}, 85%, ${60 + fire * 30}%, ${0.35 + fire * 0.55})`;
  ctx.lineWidth = 1.2 + fire * 1.5;
  ctx.stroke();

  // Inner cytoplasm texture ring
  ctx.beginPath();
  ctx.arc(n.x, n.y, somaR * 0.65, 0, Math.PI * 2);
  ctx.strokeStyle = `hsla(${n.hue + 20}, 60%, 55%, ${0.12 + fire * 0.2})`;
  ctx.lineWidth = 0.6;
  ctx.stroke();

  // Nucleus envelope
  const nucR = somaR * 0.42;
  const nucGrad = ctx.createRadialGradient(n.x - nucR * 0.25, n.y - nucR * 0.25, 0, n.x, n.y, nucR);
  nucGrad.addColorStop(0, `hsla(${n.hue + 30}, 80%, ${55 + fire * 35}%, ${0.5 + fire * 0.4})`);
  nucGrad.addColorStop(1, `hsla(${n.hue + 10}, 70%, ${30 + fire * 20}%, ${0.3 + fire * 0.3})`);
  ctx.beginPath();
  ctx.arc(n.x, n.y, nucR, 0, Math.PI * 2);
  ctx.fillStyle = nucGrad;
  ctx.fill();
  ctx.strokeStyle = `hsla(${n.hue + 30}, 90%, 70%, ${0.25 + fire * 0.45})`;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Nuclear pore dots (tiny openings in nucleus envelope)
  const poreCount = 6;
  for (let pi = 0; pi < poreCount; pi++) {
    const pa = (pi / poreCount) * Math.PI * 2 + n.phase * 0.1;
    const px = n.x + Math.cos(pa) * nucR;
    const py = n.y + Math.sin(pa) * nucR;
    ctx.beginPath();
    ctx.arc(px, py, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${n.hue}, 80%, 75%, ${0.3 + fire * 0.4})`;
    ctx.fill();
  }

  // Nucleolus (central bright dot)
  const nolR = nucR * 0.35;
  const nolGrad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, nolR);
  nolGrad.addColorStop(0, `hsla(${n.hue + 60}, 100%, ${80 + fire * 18}%, ${0.7 + fire * 0.3})`);
  nolGrad.addColorStop(1, `hsla(${n.hue + 40}, 90%, 60%, 0)`);
  ctx.fillStyle = nolGrad;
  ctx.beginPath();
  ctx.arc(n.x, n.y, nolR, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Synapse drawing ──────────────────────────────────────────────────────────

function drawSynapse(
  ctx: CanvasRenderingContext2D,
  syn: Synapse,
  neurons: Neuron[],
  working: boolean,
) {
  const from = neurons[syn.from];
  const to   = neurons[syn.to];
  const fadeIn = Math.min(syn.age / 2.0, 1);
  const str = syn.strength * fadeIn;
  if (str < 0.01) return;

  const cpX = (from.x + to.x) / 2 + syn.cpDx;
  const cpY = (from.y + to.y) / 2 + syn.cpDy;

  const alpha = 0.04 + str * (working ? 0.42 : 0.28);
  const lineW = 0.4 + str * (working ? 2.2 : 1.4);
  const hue = 195 + str * 50;

  // Glow pass for strong synapses
  if (str > 0.35) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
    ctx.strokeStyle = `hsla(${hue}, 85%, 65%, ${str * 0.13})`;
    ctx.lineWidth = lineW + 5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Main arc
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
  ctx.strokeStyle = `hsla(${hue}, 70%, 58%, ${alpha})`;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Synaptic terminal button — a small rounded knob at the arrival end
  if (str > 0.12) {
    const tang = bezierTangent(from.x, from.y, cpX, cpY, to.x, to.y, 0.92);
    const tlen = Math.hypot(tang.dx, tang.dy) || 1;
    const tnx = tang.dx / tlen, tny = tang.dy / tlen;
    const bx = to.x - tnx * (to.r * 1.1 + 3);
    const by = to.y - tny * (to.r * 1.1 + 3);
    ctx.beginPath();
    ctx.arc(bx, by, 2.5 + str * 2, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 80%, 68%, ${str * 0.7})`;
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue}, 90%, 80%, ${str * 0.5})`;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
}

// ─── Pulse drawing ────────────────────────────────────────────────────────────

function drawPulse(
  ctx: CanvasRenderingContext2D,
  p: Pulse,
  neurons: Neuron[],
  synapses: Synapse[],
  working: boolean,
) {
  const syn = findSynapse(synapses, p.from, p.to);
  if (!syn) return;
  const from = neurons[p.from];
  const to   = neurons[p.to];
  const cpX = (from.x + to.x) / 2 + syn.cpDx;
  const cpY = (from.y + to.y) / 2 + syn.cpDy;

  const head = bezierPoint(from.x, from.y, cpX, cpY, to.x, to.y, p.t);

  // Draw comet trail along the bezier (sample several points behind head)
  const trailSteps = 10;
  const trailLen = 0.14;
  for (let ti = trailSteps; ti >= 1; ti--) {
    const tt = Math.max(0, p.t - (ti / trailSteps) * trailLen);
    const tp = bezierPoint(from.x, from.y, cpX, cpY, to.x, to.y, tt);
    const tp2 = bezierPoint(from.x, from.y, cpX, cpY, to.x, to.y, Math.max(0, tt - (1 / trailSteps) * trailLen));
    const frac = 1 - ti / trailSteps;
    ctx.beginPath();
    ctx.moveTo(tp2.x, tp2.y);
    ctx.lineTo(tp.x, tp.y);
    ctx.strokeStyle = `hsla(${p.hue}, 100%, 72%, ${frac * 0.7 * (working ? 1 : 0.7)})`;
    ctx.lineWidth = p.size * 0.5 * frac;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Head — layered glow
  const gr1 = p.size * 4;
  const hg1 = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, gr1);
  hg1.addColorStop(0, `hsla(${p.hue}, 100%, 95%, ${working ? 0.8 : 0.65})`);
  hg1.addColorStop(0.3, `hsla(${p.hue}, 100%, 80%, ${working ? 0.5 : 0.35})`);
  hg1.addColorStop(1, `hsla(${p.hue}, 100%, 65%, 0)`);
  ctx.fillStyle = hg1;
  ctx.fillRect(head.x - gr1, head.y - gr1, gr1 * 2, gr1 * 2);

  // Bright core
  ctx.beginPath();
  ctx.arc(head.x, head.y, p.size * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = `hsla(${p.hue}, 80%, 95%, 0.95)`;
  ctx.fill();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NeuronBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);

  const neuronsRef      = useRef<Neuron[]>([]);
  const synapsesRef     = useRef<Synapse[]>([]);
  const pulsesRef       = useRef<Pulse[]>([]);
  const edgesRef        = useRef<EdgeSignal[]>([]);
  const thoughtTimerRef = useRef(0.8);

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
      neuronsRef.current = Array.from({ length: NEURON_COUNT }, () => {
        const r = 8 + Math.random() * 8;
        return {
          x: 60 + Math.random() * (w - 120),
          y: 60 + Math.random() * (h - 120),
          r,
          dendrites: makeDendrites(r),
          phase: Math.random() * Math.PI * 2,
          fireLevel: 0,
          actionRings: [],
          hue: 185 + Math.random() * 60, // teal → blue range, per-cell variation
        };
      });
      synapsesRef.current = [];
      pulsesRef.current = [];
      edgesRef.current = [];
      thoughtTimerRef.current = 0.8;
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

    function fireCascade(fromIdx: number, hue: number, hops: number) {
      const neurons = neuronsRef.current;
      const synapses = synapsesRef.current;
      const pulses = pulsesRef.current;
      const working = isWorkingRef.current;

      neurons[fromIdx].fireLevel = 1;
      neurons[fromIdx].actionRings.push({ r: neurons[fromIdx].r + 2, alpha: 0.9 });

      if (hops <= 0 || synapses.length === 0) return;
      const connected = synapses.filter(s => s.from === fromIdx || s.to === fromIdx);
      if (connected.length === 0) return;

      const count = Math.min(connected.length, 1 + Math.floor(Math.random() * (working ? 2 : 2)));
      const sorted = [...connected].sort((a, b) => b.strength - a.strength);
      for (const syn of sorted.slice(0, count)) {
        const toIdx = syn.from === fromIdx ? syn.to : syn.from;
        pulses.push({
          from: fromIdx, to: toIdx,
          t: 0,
          speed: (working ? 0.38 : 0.28) + Math.random() * 0.18,
          hue, size: 4 + Math.random() * 4,
          cascadeLeft: hops - 1,
        });
      }
    }

    function spawnThought() {
      const neurons = neuronsRef.current;
      const working = isWorkingRef.current;
      if (!neurons.length) return;
      const idx = Math.floor(Math.random() * neurons.length);
      const hue = working ? 175 + Math.random() * 90 : 175 + Math.random() * 70;
      fireCascade(idx, hue, working ? 3 + Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * 4));

      if (Math.random() < 0.5) {
        const ep = randomEdgePoint(w, h);
        const n = neurons[Math.floor(Math.random() * neurons.length)];
        edgesRef.current.push({
          x: ep.x, y: ep.y, tx: n.x, ty: n.y,
          t: 0, speed: 0.35 + Math.random() * 0.35,
          hue, toNeuron: neurons.indexOf(n), inbound: true,
        });
      }
    }

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const neurons = neuronsRef.current;
      const synapses = synapsesRef.current;
      const pulses = pulsesRef.current;
      const edges = edgesRef.current;

      ctx!.fillStyle = working ? 'rgb(4, 5, 18)' : 'rgb(3, 4, 14)';
      ctx!.fillRect(0, 0, w, h);

      // Thought timer
      thoughtTimerRef.current -= dt;
      if (thoughtTimerRef.current <= 0) {
        spawnThought();
        thoughtTimerRef.current = working ? 1.2 + Math.random() * 1.0 : 1.5 + Math.random() * 2.5;
      }

      // Synapse formation
      for (let i = 0; i < neurons.length; i++) {
        const n = neurons[i];
        const cnt = synapses.filter(s => s.from === i || s.to === i).length;
        if (cnt >= MAX_SYNAPSES) continue;
        if (Math.random() > LINK_FORM_CHANCE * (working ? 1.5 : 1)) continue;
        const candidates = neurons
          .map((m, j) => ({ j, d: Math.hypot(m.x - n.x, m.y - n.y) }))
          .filter(c => c.j !== i && c.d < CONNECT_RANGE && !findSynapse(synapses, i, c.j));
        if (!candidates.length) continue;
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const other = neurons[pick.j];
        const perp = { x: -(other.y - n.y), y: other.x - n.x };
        const plen = Math.hypot(perp.x, perp.y) || 1;
        const curve = (Math.random() - 0.5) * pick.d * 0.4;
        synapses.push({
          from: i, to: pick.j, strength: 0.05, age: 0,
          cpDx: (perp.x / plen) * curve, cpDy: (perp.y / plen) * curve,
        });
      }

      // Synapse aging & pruning
      for (let i = synapses.length - 1; i >= 0; i--) {
        const s = synapses[i];
        s.age += dt;
        s.strength -= LINK_FADE_RATE * dt * (working ? 0.6 : 1);
        if (s.strength < LINK_PRUNE) synapses.splice(i, 1);
      }

      // Draw synapses
      for (const syn of synapses) drawSynapse(ctx!, syn, neurons, working);

      // Draw neurons
      for (const n of neurons) drawNeuron(ctx!, n, dt, working);

      // Update & draw pulses
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const syn = findSynapse(synapses, p.from, p.to);
        if (!syn) { pulses.splice(i, 1); continue; }

        p.t += p.speed * dt;
        if (p.t >= 1) {
          syn.strength = Math.min(1, syn.strength + LINK_REINFORCE);
          neurons[p.to].fireLevel = 1;
          neurons[p.to].actionRings.push({ r: neurons[p.to].r + 2, alpha: 0.9 });

          if (p.cascadeLeft > 0 && Math.random() < (working ? 0.65 : 0.6))
            fireCascade(p.to, p.hue, p.cascadeLeft);

          // Bounce back with shifted hue
          if (p.cascadeLeft > 0 && Math.random() < (working ? 0.15 : 0.3))
            pulses.push({ from: p.to, to: p.from, t: 0, speed: p.speed * 0.8,
              hue: (p.hue + 35) % 360, size: p.size * 0.75, cascadeLeft: p.cascadeLeft - 1 });

          // Occasional outbound edge signal
          if (Math.random() < 0.12) {
            const ep = randomEdgePoint(w, h);
            const n = neurons[p.to];
            edges.push({ x: n.x, y: n.y, tx: ep.x, ty: ep.y,
              t: 0, speed: 0.45 + Math.random() * 0.35, hue: p.hue, toNeuron: -1, inbound: false });
          }

          pulses.splice(i, 1);
          continue;
        }

        drawPulse(ctx!, p, neurons, synapses, working);
      }

      // Edge signals
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i];
        e.t += e.speed * dt;
        if (e.t >= 1) {
          if (e.inbound && e.toNeuron >= 0) {
            neurons[e.toNeuron].fireLevel = 1;
            neurons[e.toNeuron].actionRings.push({ r: neurons[e.toNeuron].r + 2, alpha: 0.9 });
            fireCascade(e.toNeuron, e.hue, working ? 2 : 1);
          }
          edges.splice(i, 1);
          continue;
        }
        const cx = lerp(e.x, e.tx, e.t);
        const cy = lerp(e.y, e.ty, e.t);
        const bt = Math.max(0, e.t - 0.18);
        const bx = lerp(e.x, e.tx, bt);
        const by = lerp(e.y, e.ty, bt);
        const grad = ctx!.createLinearGradient(bx, by, cx, cy);
        grad.addColorStop(0, `hsla(${e.hue}, 100%, 65%, 0)`);
        grad.addColorStop(1, `hsla(${e.hue}, 100%, 80%, 0.75)`);
        ctx!.beginPath(); ctx!.moveTo(bx, by); ctx!.lineTo(cx, cy);
        ctx!.strokeStyle = grad; ctx!.lineWidth = 2; ctx!.lineCap = 'round'; ctx!.stroke();
        const gr = 8;
        const hg = ctx!.createRadialGradient(cx, cy, 0, cx, cy, gr);
        hg.addColorStop(0, `hsla(${e.hue}, 100%, 92%, 0.85)`);
        hg.addColorStop(1, `hsla(${e.hue}, 100%, 65%, 0)`);
        ctx!.fillStyle = hg;
        ctx!.fillRect(cx - gr, cy - gr, gr * 2, gr * 2);
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(animRef.current); };
  }, []);

  return <canvas ref={canvasRef} className="theme-canvas-bg" aria-hidden="true" />;
}
