'use client';

import { useEffect, useRef, useState } from 'react';
import type { Cell } from '@/lib/game/engine';

export const PALETTE = {
  ink: '#17120d',
  panel: '#221b14',
  line: '#3b3128',
  cream: '#f3e9d6',
  beige: '#cdb992',
  olive: '#8a9b46',
  rust: '#c0431c',
  clay: '#c07a4e',
  mustard: '#e3a91c',
};

/** A repainting clock for anything measured against a request that is still in flight. */
export function useTick(active: boolean): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      setT(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return t;
}

interface BoardProps {
  w: number;
  h: number;
  snake: Cell[];
  food: Cell | null;
  obstacles: Cell[];
  waiting: boolean;
  size?: number;
}

export default function Board({ w, h, snake, food, obstacles, waiting, size = 560 }: BoardProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const spin = useTick(waiting);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const cell = Math.floor(size / Math.max(w, h));
    const px = (n: number) => n * cell;
    canvas.width = px(w);
    canvas.height = px(h);

    ctx.fillStyle = PALETTE.panel;
    ctx.fillRect(0, 0, px(w), px(h));

    ctx.strokeStyle = PALETTE.line;
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x++) {
      ctx.beginPath();
      ctx.moveTo(px(x) + 0.5, 0);
      ctx.lineTo(px(x) + 0.5, px(h));
      ctx.stroke();
    }
    for (let y = 0; y <= h; y++) {
      ctx.beginPath();
      ctx.moveTo(0, px(y) + 0.5);
      ctx.lineTo(px(w), px(y) + 0.5);
      ctx.stroke();
    }

    // Obstacles carry a diagonal cross so they never rely on colour alone.
    for (const [x, y] of obstacles) {
      ctx.fillStyle = PALETTE.clay;
      ctx.fillRect(px(x), px(y), cell, cell);
      ctx.strokeStyle = PALETTE.ink;
      ctx.beginPath();
      ctx.moveTo(px(x) + 2, px(y) + 2);
      ctx.lineTo(px(x + 1) - 2, px(y + 1) - 2);
      ctx.moveTo(px(x + 1) - 2, px(y) + 2);
      ctx.lineTo(px(x) + 2, px(y + 1) - 2);
      ctx.stroke();
    }

    if (food) {
      ctx.fillStyle = PALETTE.mustard;
      ctx.beginPath();
      ctx.arc(px(food[0]) + cell / 2, px(food[1]) + cell / 2, cell * 0.33, 0, Math.PI * 2);
      ctx.fill();
    }

    snake.slice(1).forEach(([x, y]) => {
      ctx.fillStyle = PALETTE.olive;
      ctx.fillRect(px(x) + 1, px(y) + 1, cell - 2, cell - 2);
    });

    const [hx, hy] = snake[0];
    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(px(hx) + 1, px(hy) + 1, cell - 2, cell - 2);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(px(hx) + cell * 0.35, px(hy) + cell * 0.35, cell * 0.3, cell * 0.3);

    if (waiting) {
      ctx.fillStyle = 'rgba(23, 18, 13, 0.55)';
      ctx.fillRect(0, 0, px(w), px(h));
      const angle = (spin / 140) % (Math.PI * 2);
      ctx.strokeStyle = PALETTE.mustard;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px(hx) + cell / 2, px(hy) + cell / 2, cell * 0.9, angle, angle + Math.PI * 1.2);
      ctx.stroke();
    }
  }, [w, h, snake, food, obstacles, waiting, spin, size]);

  return <canvas ref={ref} className="border border-line" aria-label="snake board" />;
}
