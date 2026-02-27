import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/ui';

/**
 * Circuit — a modern take on network/circuit aesthetics.
 * Sparse hexagonal grid with clean geometric lines, data packets that travel
 * along edges, and occasional node activations that ripple outward.
 * Think: TRON Legacy meets Bloomberg terminal.
 */

interface HexNode {
  x: number;
  y: number;
  neighbors: number[];
  active: boolean;
  activateAt: number;
  ripple: number;
  phase: number;
}

interface DataPacket {
  fromIdx: number;
  toIdx: number;
  progress: number;
  speed: number;
  hue: number;
}

const HEX_SIZE = 60;
const SQRT3 = Math.sqrt(3);

function createHexGrid(w: number, h: number): HexNode[] {
  const nodes: HexNode[] = [];
  const cols = Math.ceil(w / (HEX_SIZE * 1.5)) + 2;
  const rows = Math.ceil(h / (HEX_SIZE * SQRT3)) + 2;

  // Create hex centers
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * HEX_SIZE * 1.5;
      const y = row * HEX_SIZE * SQRT3 + (col % 2 ? HEX_SIZE * SQRT3 * 0.5 : 0);
      nodes.push({
        x,
        y,
        neighbors: [],
        active: false,
        activateAt: Infinity,
        ripple: 0,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  // Connect neighbors (hex adjacency)
  const maxDist = HEX_SIZE * 1.2;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < maxDist) {
        nodes[i].neighbors.push(j);
        nodes[j].neighbors.push(i);
      }
    }
  }

  return nodes;
}

export function CircuitBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const nodesRef = useRef<HexNode[]>([]);
  const packetsRef = useRef<DataPacket[]>([]);
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
      nodesRef.current = createHexGrid(window.innerWidth, window.innerHeight);
      packetsRef.current = [];
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
      const nodes = nodesRef.current;
      const packets = packetsRef.current;

      ctx!.clearRect(0, 0, w, h);

      const baseAlpha = working ? 0.3 : 0.14;
      const nodeAlpha = working ? 0.6 : 0.3;

      // Spawn data packets
      const packetRate = working ? 8 : 1.5;
      if (Math.random() < packetRate * dt && packets.length < 40) {
        const startIdx = Math.floor(Math.random() * nodes.length);
        const node = nodes[startIdx];
        if (node.neighbors.length > 0) {
          const toIdx = node.neighbors[Math.floor(Math.random() * node.neighbors.length)];
          packets.push({
            fromIdx: startIdx,
            toIdx,
            progress: 0,
            speed: 0.8 + Math.random() * 1.2,
            hue: 190 + Math.random() * 30, // cyan range
          });
        }
      }

      // Trigger node activations
      if (Math.random() < (working ? 3 : 0.5) * dt) {
        const idx = Math.floor(Math.random() * nodes.length);
        nodes[idx].active = true;
        nodes[idx].activateAt = time;
        nodes[idx].ripple = 0;
      }

      // Draw edges
      ctx!.lineWidth = 0.5;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        for (const j of node.neighbors) {
          if (j <= i) continue;
          const other = nodes[j];

          ctx!.beginPath();
          ctx!.moveTo(node.x, node.y);
          ctx!.lineTo(other.x, other.y);
          ctx!.strokeStyle = `rgba(60, 180, 220, ${baseAlpha})`;
          ctx!.stroke();
        }
      }

      // Draw and update packets
      for (let i = packets.length - 1; i >= 0; i--) {
        const pkt = packets[i];
        pkt.progress += pkt.speed * dt;

        if (pkt.progress >= 1) {
          // Chain to next edge
          const arriveNode = nodes[pkt.toIdx];
          if (arriveNode.neighbors.length > 0 && Math.random() < 0.6) {
            const candidates = arriveNode.neighbors.filter(n => n !== pkt.fromIdx);
            const next = candidates.length > 0
              ? candidates[Math.floor(Math.random() * candidates.length)]
              : arriveNode.neighbors[Math.floor(Math.random() * arriveNode.neighbors.length)];
            pkt.fromIdx = pkt.toIdx;
            pkt.toIdx = next;
            pkt.progress = 0;
          } else {
            packets.splice(i, 1);
            continue;
          }
        }

        const from = nodes[pkt.fromIdx];
        const to = nodes[pkt.toIdx];
        const px = from.x + (to.x - from.x) * pkt.progress;
        const py = from.y + (to.y - from.y) * pkt.progress;

        // Packet trail
        const trailLen = 0.3;
        const trailStart = Math.max(0, pkt.progress - trailLen);
        const tx = from.x + (to.x - from.x) * trailStart;
        const ty = from.y + (to.y - from.y) * trailStart;

        const grad = ctx!.createLinearGradient(tx, ty, px, py);
        grad.addColorStop(0, `hsla(${pkt.hue}, 90%, 65%, 0)`);
        grad.addColorStop(1, `hsla(${pkt.hue}, 90%, 65%, ${working ? 0.8 : 0.55})`);
        ctx!.beginPath();
        ctx!.moveTo(tx, ty);
        ctx!.lineTo(px, py);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = working ? 2.5 : 1.5;
        ctx!.stroke();

        // Packet head glow
        const glowR = working ? 8 : 5;
        const headGrad = ctx!.createRadialGradient(px, py, 0, px, py, glowR);
        headGrad.addColorStop(0, `hsla(${pkt.hue}, 90%, 80%, ${working ? 0.9 : 0.6})`);
        headGrad.addColorStop(1, `hsla(${pkt.hue}, 90%, 75%, 0)`);
        ctx!.fillStyle = headGrad;
        ctx!.fillRect(px - glowR, py - glowR, glowR * 2, glowR * 2);
      }

      // Draw nodes
      for (const node of nodes) {
        node.phase += dt * 0.8;

        // Activation ripple
        if (node.active) {
          node.ripple = (time - node.activateAt) * 0.08;
          if (node.ripple > 40) {
            node.active = false;
          } else {
            const rippleAlpha = (1 - node.ripple / 40) * (working ? 0.5 : 0.25);
            ctx!.beginPath();
            ctx!.arc(node.x, node.y, node.ripple, 0, Math.PI * 2);
            ctx!.strokeStyle = `rgba(80, 200, 240, ${rippleAlpha})`;
            ctx!.lineWidth = 1;
            ctx!.stroke();
          }
        }

        // Node dot — small, clean
        const pulse = Math.sin(node.phase) * 0.3 + 0.7;
        const r = 1.5 * pulse;
        const alpha = nodeAlpha * pulse;

        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(100, 210, 240, ${alpha})`;
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
