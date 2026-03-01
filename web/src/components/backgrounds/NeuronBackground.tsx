import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Neuron — a living neural network that builds its own connections over time.
 *
 * Neurons are scattered across the screen. Synaptic links form gradually.
 * Every time a signal travels a link, that link strengthens (grows brighter/thicker).
 * Links that go unused slowly fade and eventually vanish.
 * "Thoughts" are bursts of signals that cascade from neuron to neuron,
 * bouncing back and forth, growing, collapsing — like real neural activity.
 * Signals occasionally arrive from or leave toward the screen edges.
 *
 * Idle: slow pulses, gentle link formation, occasional thoughts.
 * Working: rapid fire, cascades overlap, links strengthen fast.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const NEURON_COUNT        = 55;
const MAX_SYNAPSES        = 5;      // max connections per neuron
const CONNECT_RANGE       = 220;    // max distance to form a synapse
const LINK_FADE_RATE      = 0.006;  // strength lost per second when idle
const LINK_REINFORCE      = 0.18;   // strength gained per signal
const LINK_FORM_CHANCE    = 0.008;  // per-frame per-neuron chance to grow a new link
const LINK_PRUNE_THRESH   = 0.03;   // links below this are removed

// ─── Types ───────────────────────────────────────────────────────────────────

interface Neuron {
  x: number;
  y: number;
  r: number;          // soma radius
  phase: number;      // idle pulse phase
  fireLevel: number;  // 0-1 glow when recently fired
  lastFired: number;
}

interface Synapse {
  from: number;       // neuron index
  to: number;
  strength: number;   // 0-1
  age: number;        // seconds since formed (for initial fade-in)
}

interface Pulse {
  from: number;       // neuron index
  to: number;         // neuron index
  t: number;          // 0-1 progress along the synapse
  speed: number;
  hue: number;
  size: number;
  cascadeLeft: number; // how many hops remain in this thought
  reverse: boolean;
}

interface EdgeSignal {
  // A signal traveling from screen edge to a neuron, or neuron to edge
  x: number; y: number;     // current position
  tx: number; ty: number;   // target
  t: number;                // 0-1 progress
  speed: number;
  hue: number;
  toNeuron: number;         // -1 = leaving to edge
  inbound: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomEdgePoint(w: number, h: number): { x: number; y: number } {
  const side = Math.floor(Math.random() * 4);
  switch (side) {
    case 0: return { x: Math.random() * w, y: 0 };
    case 1: return { x: Math.random() * w, y: h };
    case 2: return { x: 0, y: Math.random() * h };
    default: return { x: w, y: Math.random() * h };
  }
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function findSynapse(synapses: Synapse[], from: number, to: number): Synapse | undefined {
  return synapses.find(s => (s.from === from && s.to === to) || (s.from === to && s.to === from));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NeuronBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);

  const neuronsRef    = useRef<Neuron[]>([]);
  const synapsesRef   = useRef<Synapse[]>([]);
  const pulsesRef     = useRef<Pulse[]>([]);
  const edgesRef      = useRef<EdgeSignal[]>([]);
  const thoughtTimerRef = useRef(0);

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
      neuronsRef.current = Array.from({ length: NEURON_COUNT }, () => ({
        x: 40 + Math.random() * (w - 80),
        y: 40 + Math.random() * (h - 80),
        r: 3 + Math.random() * 4,
        phase: Math.random() * Math.PI * 2,
        fireLevel: 0,
        lastFired: 0,
      }));
      synapsesRef.current = [];
      pulsesRef.current = [];
      edgesRef.current = [];
      thoughtTimerRef.current = 1.0; // first thought soon
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

    // ── Fire a cascade from a neuron ─────────────────────────────────────────

    function fireCascade(fromIdx: number, hue: number, hops: number) {
      const neurons = neuronsRef.current;
      const synapses = synapsesRef.current;
      const pulses = pulsesRef.current;
      const working = isWorkingRef.current;

      neurons[fromIdx].fireLevel = 1;
      neurons[fromIdx].lastFired = performance.now() / 1000;

      if (synapses.length === 0 || hops <= 0) return;

      // Pick 1-3 target synapses, biased toward stronger ones
      const connected = synapses.filter(s => s.from === fromIdx || s.to === fromIdx);
      if (connected.length === 0) return;

      const count = Math.min(connected.length, 1 + Math.floor(Math.random() * (working ? 3 : 2)));
      // Weighted sample by strength
      const sorted = [...connected].sort((a, b) => b.strength - a.strength);
      const picks = sorted.slice(0, count);

      for (const syn of picks) {
        const toIdx = syn.from === fromIdx ? syn.to : syn.from;
        const reverse = syn.to === fromIdx; // signal direction
        pulses.push({
          from: fromIdx, to: toIdx,
          t: 0,
          speed: (working ? 0.6 : 0.3) + Math.random() * 0.3,
          hue,
          size: 3 + Math.random() * 3,
          cascadeLeft: hops - 1,
          reverse,
        });
      }
    }

    // ── Spawn a "thought" ─────────────────────────────────────────────────────

    function spawnThought() {
      const neurons = neuronsRef.current;
      const working = isWorkingRef.current;
      if (neurons.length === 0) return;

      const startIdx = Math.floor(Math.random() * neurons.length);
      const hue = working ? Math.random() * 360 : 180 + Math.random() * 80; // teal-blue when idle
      const hops = working ? 4 + Math.floor(Math.random() * 8) : 2 + Math.floor(Math.random() * 4);
      fireCascade(startIdx, hue, hops);

      // Also spawn an inbound edge signal toward a random neuron
      if (Math.random() < 0.5) {
        const ep = randomEdgePoint(w, h);
        const n = neurons[Math.floor(Math.random() * neurons.length)];
        edgesRef.current.push({
          x: ep.x, y: ep.y, tx: n.x, ty: n.y,
          t: 0, speed: 0.4 + Math.random() * 0.4,
          hue, toNeuron: neurons.indexOf(n), inbound: true,
        });
      }
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    function draw(time: number) {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const working = isWorkingRef.current;
      const neurons = neuronsRef.current;
      const synapses = synapsesRef.current;
      const pulses = pulsesRef.current;
      const edges = edgesRef.current;

      // Background
      ctx!.fillStyle = working ? 'rgb(4, 5, 16)' : 'rgb(3, 4, 12)';
      ctx!.fillRect(0, 0, w, h);

      // ── Thought timer ───────────────────────────────────────────────────────
      thoughtTimerRef.current -= dt;
      if (thoughtTimerRef.current <= 0) {
        spawnThought();
        if (working) {
          // Spawn 1-2 extra overlapping thoughts
          const extra = Math.floor(Math.random() * 2);
          for (let e = 0; e < extra; e++) spawnThought();
        }
        thoughtTimerRef.current = working ? 0.4 + Math.random() * 0.8 : 1.5 + Math.random() * 2.5;
      }

      // ── Synapse formation ───────────────────────────────────────────────────
      for (let i = 0; i < neurons.length; i++) {
        const n = neurons[i];
        const existingCount = synapses.filter(s => s.from === i || s.to === i).length;
        if (existingCount >= MAX_SYNAPSES) continue;
        if (Math.random() > LINK_FORM_CHANCE * (working ? 3 : 1)) continue;

        // Find a candidate neuron in range, not yet connected
        const candidates = neurons
          .map((m, j) => ({ j, dx: m.x - n.x, dy: m.y - n.y }))
          .filter(c => c.j !== i && Math.hypot(c.dx, c.dy) < CONNECT_RANGE)
          .filter(c => !findSynapse(synapses, i, c.j));

        if (candidates.length > 0) {
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          synapses.push({ from: i, to: pick.j, strength: 0.05, age: 0 });
        }
      }

      // ── Synapse aging & pruning ─────────────────────────────────────────────
      for (let i = synapses.length - 1; i >= 0; i--) {
        const s = synapses[i];
        s.age += dt;
        s.strength -= LINK_FADE_RATE * dt * (working ? 0.3 : 1.0);
        if (s.strength < LINK_PRUNE_THRESH) {
          synapses.splice(i, 1);
        }
      }

      // ── Draw synapses ───────────────────────────────────────────────────────
      for (const syn of synapses) {
        const from = neurons[syn.from];
        const to   = neurons[syn.to];
        const fadeIn = Math.min(syn.age / 1.5, 1);
        const str = syn.strength * fadeIn;
        const alpha = 0.04 + str * (working ? 0.45 : 0.3);
        const lineW  = 0.5 + str * (working ? 2.5 : 1.5);
        const hue = 195 + str * 40; // cyan to blue-white as it strengthens

        // Outer glow for strong links
        if (str > 0.4) {
          ctx!.beginPath();
          ctx!.moveTo(from.x, from.y);
          ctx!.lineTo(to.x, to.y);
          ctx!.strokeStyle = `hsla(${hue}, 80%, 65%, ${str * 0.15})`;
          ctx!.lineWidth = lineW + 4;
          ctx!.stroke();
        }

        ctx!.beginPath();
        ctx!.moveTo(from.x, from.y);
        ctx!.lineTo(to.x, to.y);
        ctx!.strokeStyle = `hsla(${hue}, 70%, 60%, ${alpha})`;
        ctx!.lineWidth = lineW;
        ctx!.stroke();
      }

      // ── Draw neurons ────────────────────────────────────────────────────────
      for (const n of neurons) {
        n.phase += dt * (working ? 1.2 : 0.5);
        n.fireLevel = Math.max(0, n.fireLevel - dt * (working ? 2 : 1.2));

        const pulse = (Math.sin(n.phase) + 1) / 2;  // 0-1
        const fire  = n.fireLevel;
        const glow  = fire > 0 ? fire : pulse * 0.15;

        // Outer aura
        const auraR = n.r * (3 + glow * 8);
        const aura = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, auraR);
        const hue  = fire > 0.3 ? (200 + fire * 60) : 190;
        aura.addColorStop(0, `hsla(${hue}, 90%, 70%, ${glow * 0.5})`);
        aura.addColorStop(1, `hsla(${hue}, 90%, 60%, 0)`);
        ctx!.fillStyle = aura;
        ctx!.fillRect(n.x - auraR, n.y - auraR, auraR*2, auraR*2);

        // Soma body
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.r + fire * 2, 0, Math.PI * 2);
        ctx!.fillStyle = `hsla(${hue}, 80%, ${50 + fire * 40}%, ${0.5 + fire * 0.5})`;
        ctx!.fill();
        ctx!.strokeStyle = `hsla(${hue}, 90%, 75%, ${0.3 + fire * 0.6})`;
        ctx!.lineWidth = 0.8;
        ctx!.stroke();
      }

      // ── Update and draw pulses ──────────────────────────────────────────────
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const syn = findSynapse(synapses, p.from, p.to);
        if (!syn) { pulses.splice(i, 1); continue; }

        p.t += p.speed * dt;

        if (p.t >= 1) {
          // Arrived — reinforce synapse, maybe cascade
          syn.strength = Math.min(1, syn.strength + LINK_REINFORCE);
          neurons[p.to].fireLevel = 1;

          if (p.cascadeLeft > 0 && Math.random() < (isWorkingRef.current ? 0.85 : 0.6)) {
            fireCascade(p.to, p.hue, p.cascadeLeft);
          }

          // Occasionally bounce back
          if (p.cascadeLeft > 0 && Math.random() < 0.35) {
            pulses.push({
              from: p.to, to: p.from,
              t: 0, speed: p.speed * 0.85,
              hue: (p.hue + 30) % 360,
              size: p.size * 0.8,
              cascadeLeft: p.cascadeLeft - 1,
              reverse: !p.reverse,
            });
          }

          // Occasionally send an outbound edge signal
          if (Math.random() < 0.15) {
            const ep = randomEdgePoint(w, h);
            const n = neurons[p.to];
            edgesRef.current.push({
              x: n.x, y: n.y, tx: ep.x, ty: ep.y,
              t: 0, speed: 0.5 + Math.random() * 0.4,
              hue: p.hue, toNeuron: -1, inbound: false,
            });
          }

          pulses.splice(i, 1);
          continue;
        }

        // Draw pulse along synapse
        const from = neurons[p.from];
        const to   = neurons[p.to];
        const px   = lerp(from.x, to.x, p.t);
        const py   = lerp(from.y, to.y, p.t);

        // Trail
        const trailLen = 0.18;
        const t0 = Math.max(0, p.t - trailLen);
        const tx = lerp(from.x, to.x, t0);
        const ty = lerp(from.y, to.y, t0);
        const grad = ctx!.createLinearGradient(tx, ty, px, py);
        grad.addColorStop(0, `hsla(${p.hue}, 100%, 65%, 0)`);
        grad.addColorStop(1, `hsla(${p.hue}, 100%, 82%, 0.9)`);
        ctx!.beginPath(); ctx!.moveTo(tx, ty); ctx!.lineTo(px, py);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = p.size * 0.6;
        ctx!.lineCap = 'round';
        ctx!.stroke();

        // Head glow
        const gr = p.size * 2.5;
        const hg = ctx!.createRadialGradient(px, py, 0, px, py, gr);
        hg.addColorStop(0, `hsla(${p.hue}, 100%, 90%, 0.95)`);
        hg.addColorStop(1, `hsla(${p.hue}, 100%, 70%, 0)`);
        ctx!.fillStyle = hg;
        ctx!.fillRect(px - gr, py - gr, gr*2, gr*2);
      }

      // ── Update and draw edge signals ────────────────────────────────────────
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i];
        e.t += e.speed * dt;
        if (e.t >= 1) {
          // Inbound signals fire the destination neuron
          if (e.inbound && e.toNeuron >= 0) {
            neurons[e.toNeuron].fireLevel = 1;
            fireCascade(e.toNeuron, e.hue, isWorkingRef.current ? 3 : 1);
          }
          edges.splice(i, 1);
          continue;
        }

        const cx = lerp(e.x, e.tx, e.t);
        const cy = lerp(e.y, e.ty, e.t);
        const bt = Math.max(0, e.t - 0.2);
        const bx = lerp(e.x, e.tx, bt);
        const by = lerp(e.y, e.ty, bt);
        const grad = ctx!.createLinearGradient(bx, by, cx, cy);
        grad.addColorStop(0, `hsla(${e.hue}, 100%, 65%, 0)`);
        grad.addColorStop(1, `hsla(${e.hue}, 100%, 80%, 0.7)`);
        ctx!.beginPath(); ctx!.moveTo(bx, by); ctx!.lineTo(cx, cy);
        ctx!.strokeStyle = grad; ctx!.lineWidth = 2; ctx!.stroke();

        // Head dot
        const gr = 7;
        const hg = ctx!.createRadialGradient(cx, cy, 0, cx, cy, gr);
        hg.addColorStop(0, `hsla(${e.hue}, 100%, 90%, 0.8)`);
        hg.addColorStop(1, `hsla(${e.hue}, 100%, 70%, 0)`);
        ctx!.fillStyle = hg;
        ctx!.fillRect(cx - gr, cy - gr, gr*2, gr*2);
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
