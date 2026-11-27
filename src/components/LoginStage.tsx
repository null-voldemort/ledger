import React, { useEffect, useRef } from 'react';

 










interface ChainNodeDef {
  label: string;
  rx: number;  
  ry: number;  
  core?: boolean;
  align: 't' | 'b' | 'l' | 'r';
}

const CHAIN_NODES: ChainNodeDef[] = [
  { label: 'Treasury Source', rx: 0.12, ry: 0.24, align: 't' },
  { label: 'Bank & ATM', rx: 0.14, ry: 0.68, align: 'b' },
  { label: 'Cheque Clearing', rx: 0.34, ry: 0.18, align: 't' },
  { label: 'Transfer Relay', rx: 0.33, ry: 0.56, align: 'b' },
  { label: 'Pace IT Ledger', rx: 0.54, ry: 0.44, core: true, align: 't' },
  { label: 'Expense Allocation', rx: 0.74, ry: 0.24, align: 't' },
  { label: 'Voucher Proof', rx: 0.76, ry: 0.68, align: 'b' },
  { label: 'Audit Chain Seal', rx: 0.91, ry: 0.45, align: 'b' },
];

const CHAIN_LINKS: [number, number][] = [
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 4],
  [3, 4],
  [1, 4],
  [4, 5],
  [4, 6],
  [5, 7],
  [6, 7],
  [5, 6],
];

const PALETTE = ['#6fcf88', '#f7ee3c', '#4ba6e2', '#34d399', '#8fd0f2'];
const MINT = '191, 243, 210';

interface Props {
  busy?: boolean;
  className?: string;
}

interface RNode {
  label: string;
  rx: number;
  ry: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  core: boolean;
  align: ChainNodeDef['align'];
  glow: number;
  ping: number;
  delay: number;
}

interface TransferPulse {
  from: number;
  to: number;
  t: number;
  speed: number;
  color: string;
  curve: number;
  hop: number;
}

interface CurrencyFloat {
  x: number;
  y: number;
  t: number;
  symbol: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (v: number) => 1 - Math.pow(1 - v, 3);

function bezierPoint(
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  bx: number,
  by: number,
  t: number,
): [number, number] {
  const u = 1 - t;
  return [
    u * u * ax + 2 * u * t * cx + t * t * bx,
    u * u * ay + 2 * u * t * cy + t * t * by,
  ];
}

export const LoginStage: React.FC<Props> = ({ busy = false, className = '' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coreIndex = CHAIN_NODES.findIndex((n) => n.core);

    const nodes: RNode[] = CHAIN_NODES.map((n, i) => ({
      label: n.label,
      rx: n.rx,
      ry: n.ry,
      x: 0,
      y: 0,
      ox: 0,
      oy: 0,
      core: Boolean(n.core),
      align: n.align,
      glow: 0,
      ping: -1,
      delay: 0.12 + i * 0.09,
    }));

    const outgoing: number[][] = nodes.map(() => []);
    CHAIN_LINKS.forEach(([a, b]) => {
      outgoing[a].push(b);
    });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let rw = 0;
    let rh = 0;
    let compact = false;

    const layout = () => {
      const rect = host.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const wide = w >= 1024;
      rw = wide ? w * 0.57 : w;
      rh = wide ? h : Math.min(h, w < 640 ? 225 : 272);
      compact = rh < 340;

      const pad = compact
        ? { l: 48, r: 48, t: 28, b: 36 }
        : { l: rw * 0.08, r: rw * 0.09, t: rh * 0.14, b: rh * 0.34 };
      const aw = Math.max(60, rw - pad.l - pad.r);
      const ah = Math.max(60, rh - pad.t - pad.b);

      nodes.forEach((n) => {
        n.x = pad.l + n.rx * aw;
        n.y = pad.t + n.ry * ah;
      });
    };

    let pointer: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => {
      pointer = null;
    };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);

    const pulses: TransferPulse[] = [];
    const floaters: CurrencyFloat[] = [];
    let spawnAcc = 0;
    let time = reduced ? 99 : 0;

    const spawnChain = () => {
      const starts = [0, 1];
      const from = starts[Math.floor(Math.random() * starts.length)];
      const nexts = outgoing[from];
      if (!nexts.length) return;
      const to = nexts[Math.floor(Math.random() * nexts.length)];
      pulses.push({
        from,
        to,
        t: 0,
        speed: busyRef.current ? 1.15 : 0.48 + Math.random() * 0.24,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        curve: from % 2 === 0 ? -24 : 24,
        hop: 0,
      });
    };

    const step = (dt: number) => {
      time += dt;
      const busyNow = busyRef.current;

      spawnAcc += dt * (busyNow ? 5.5 : 1.7);
      while (spawnAcc >= 1 && time > 0.7) {
        spawnAcc -= 1;
        spawnChain();
      }
      if (spawnAcc > 3) spawnAcc = 0;

      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.t += dt * p.speed;
        if (p.t >= 1) {
          pulses.splice(i, 1);
          const node = nodes[p.to];
          node.ping = 0;
          if (!busyNow && (node.core || Math.random() < 0.35)) {
            floaters.push({
              x: node.x + node.ox,
              y: node.y + node.oy - 14,
              t: 0,
              symbol: node.core ? '৳ Verified' : '৳',
            });
          }
          const nexts = outgoing[p.to];
          if (nexts.length && p.hop < 4) {
            const nextTo = nexts[Math.floor(Math.random() * nexts.length)];
            pulses.push({
              from: p.to,
              to: nextTo,
              t: 0,
              speed: busyNow ? 1.25 : 0.52 + Math.random() * 0.22,
              color: p.color,
              curve: (p.to + nextTo) % 2 === 0 ? -22 : 22,
              hop: p.hop + 1,
            });
          }
        }
      }

      for (let i = floaters.length - 1; i >= 0; i--) {
        floaters[i].t += dt;
        if (floaters[i].t > 1.5) floaters.splice(i, 1);
      }

      for (const n of nodes) {
        if (n.ping >= 0) {
          n.ping += dt / (n.core ? 1.25 : 0.85);
          if (n.ping >= 1) n.ping = -1;
        }
        let targetGlow = 0;
        let tx = 0;
        let ty = 0;
        if (pointer) {
          const d = Math.hypot(pointer.x - n.x, pointer.y - n.y);
          targetGlow = clamp01(1 - d / 160);
          tx = (pointer.x - n.x) * 0.05 * targetGlow;
          ty = (pointer.y - n.y) * 0.05 * targetGlow;
        }
        const k = 1 - Math.exp(-dt * 8);
        n.glow += (targetGlow - n.glow) * k;
        n.ox += (tx - n.ox) * k;
        n.oy += (ty - n.oy) * k;
      }
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

       
      ctx.fillStyle = 'rgba(191, 243, 210, 0.06)';
      for (let gx = 20; gx < w; gx += 32) {
        for (let gy = 20; gy < h; gy += 32) ctx.fillRect(gx, gy, 1.5, 1.5);
      }

       
      const core = nodes[coreIndex];
      const coreAppear = easeOut(clamp01((time - core.delay) / 0.6));
      if (coreAppear > 0) {
        const rad = Math.min(rw, rh) * 0.45;
        const grad = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, rad);
        grad.addColorStop(0, `rgba(111, 207, 136, ${0.22 * coreAppear})`);
        grad.addColorStop(1, 'rgba(111, 207, 136, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }

       
      for (let i = 0; i < CHAIN_LINKS.length; i++) {
        const [ai, bi] = CHAIN_LINKS[i];
        const a = nodes[ai];
        const b = nodes[bi];
        const grow = easeOut(clamp01((time - Math.max(a.delay, b.delay)) / 0.6));
        if (grow <= 0) continue;

        const ax = a.x + a.ox;
        const ay = a.y + a.oy;
        const bx = b.x + b.ox;
        const by = b.y + b.oy;
        const curve = ai % 2 === 0 ? -24 : 24;
        const cx = (ax + bx) / 2;
        const cy = (ay + by) / 2 + curve;
        const lit = Math.max(a.glow, b.glow);

        ctx.strokeStyle = `rgba(${MINT}, ${0.18 + lit * 0.28})`;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cx, cy, ax + (bx - ax) * grow, ay + (by - ay) * grow);
        ctx.stroke();
        ctx.setLineDash([]);
      }

       
      ctx.globalCompositeOperation = 'lighter';
      for (const p of pulses) {
        const a = nodes[p.from];
        const b = nodes[p.to];
        const ax = a.x + a.ox;
        const ay = a.y + a.oy;
        const bx = b.x + b.ox;
        const by = b.y + b.oy;
        const cx = (ax + bx) / 2;
        const cy = (ay + by) / 2 + p.curve;

        const [hx, hy] = bezierPoint(ax, ay, cx, cy, bx, by, p.t);
        const [tx, ty] = bezierPoint(ax, ay, cx, cy, bx, by, clamp01(p.t - 0.2));

        const grad = ctx.createLinearGradient(tx, ty, hx, hy);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(1, p.color);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.arc(hx, hy, 8, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

       
      const fs = compact ? 9.5 : 11.5;
      for (const n of nodes) {
        const appear = easeOut(clamp01((time - n.delay) / 0.5));
        if (appear <= 0) continue;
        const x = n.x + n.ox;
        const y = n.y + n.oy;
        const size = (n.core ? 14 : 9) * (0.5 + 0.5 * appear) + n.glow * 2;

        if (n.ping >= 0) {
          const ringR = size + n.ping * (n.core ? 38 : 22);
          ctx.strokeStyle = n.core
            ? `rgba(247, 238, 60, ${(1 - n.ping) * 0.7})`
            : `rgba(${MINT}, ${(1 - n.ping) * 0.5})`;
          ctx.lineWidth = n.core ? 1.8 : 1.2;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }

         
        ctx.fillStyle = n.core ? 'rgba(255, 247, 176, 0.16)' : `rgba(${MINT}, ${0.12 + n.glow * 0.16})`;
        ctx.strokeStyle = n.core ? 'rgba(255, 247, 176, 0.65)' : `rgba(${MINT}, ${0.42 + n.glow * 0.35})`;
        ctx.lineWidth = n.core ? 1.5 : 1.1;
        const box = size * 2;
        const r = n.core ? 9 : 6;
        ctx.beginPath();
        ctx.roundRect(x - size, y - size, box, box, r);
        ctx.fill();
        ctx.stroke();

         
        ctx.fillStyle = n.core ? '#fff7b0' : `rgb(${MINT})`;
        ctx.font = `700 ${n.core ? 13 : 10}px 'Fustat', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('৳', x, y + 0.5);

         
        if (!compact || n.core) {
          ctx.font = `${n.core ? 700 : 500} ${n.core ? fs + 1 : fs}px 'Fustat', system-ui, sans-serif`;
          ctx.fillStyle = `rgba(226, 247, 234, ${(0.76 + n.glow * 0.24) * appear})`;
          const gap = size + 9;
          if (n.align === 't') {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(n.label, x, y - gap);
          } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(n.label, x, y + gap);
          }
        }
      }

       
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `700 ${fs}px 'Fustat', system-ui, sans-serif`;
      for (const f of floaters) {
        const k = f.t / 1.5;
        ctx.fillStyle = `rgba(247, 238, 60, ${(1 - k) * 0.9})`;
        ctx.fillText(f.symbol, f.x, f.y - k * 20);
      }
    };

    layout();
    let raf = 0;
    let last = performance.now();
    let ro: ResizeObserver | null = null;

    if (reduced) {
      draw();
      ro = new ResizeObserver(() => {
        layout();
        draw();
      });
    } else {
      const frame = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        step(dt);
        draw();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      ro = new ResizeObserver(layout);
    }
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={`block ${className}`} />;
};
