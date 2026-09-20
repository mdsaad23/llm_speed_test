import { describe, expect, it } from 'vitest';
import {
  bfsDistance, createGame, deadlineAt, defaultConfig, paceFactorAt, speedCpsAt, step,
  type Config, type Dir,
} from '@/lib/game/engine';
import { greedyAdapter } from '@/lib/decide/adapters';

const play = async (cfg: Config, ticks: number) => {
  const greedy = greedyAdapter();
  const signal = new AbortController().signal;
  let s = createGame(cfg);
  for (let i = 0; i < ticks && s.alive; i++) {
    const { move } = await greedy.decide({ state: s, cfg, mode: 'deadline', hints: false, signal });
    s = step(s, move, cfg);
  }
  return s;
};

describe('determinism', () => {
  it('replays identically from the same seed and moves', () => {
    const cfg = defaultConfig({ seed: 101 });
    const moves: Dir[] = ['RIGHT', 'DOWN', 'DOWN', 'LEFT', 'UP', 'RIGHT', 'RIGHT', 'DOWN'];
    const run = () => moves.reduce((s, m) => step(s, m, cfg), createGame(cfg));
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('diverges on a different seed', () => {
    expect(createGame(defaultConfig({ seed: 101 })).food).not.toEqual(
      createGame(defaultConfig({ seed: 102 })).food,
    );
  });
});

describe('pace', () => {
  const cfg = defaultConfig({ baseDeadlineMs: 8000, minDeadlineMs: 1, paceFactor: 1.05 });

  it('P_k is 1.05^k', () => {
    for (const k of [0, 1, 5, 20]) expect(paceFactorAt(k, cfg)).toBe(1.05 ** k);
  });

  it('deadline_k is base / P_k', () => {
    for (const k of [0, 1, 5, 20]) expect(deadlineAt(k, cfg)).toBe(8000 / 1.05 ** k);
  });

  it('honours the deadline floor', () => {
    expect(deadlineAt(200, defaultConfig({ minDeadlineMs: 250 }))).toBe(250);
  });

  it('freerun speed is base * P_k', () => {
    expect(speedCpsAt(3, cfg)).toBe(2 * 1.05 ** 3);
  });
});

describe('rules', () => {
  it('length is 3 + foods eaten', async () => {
    const s = await play(defaultConfig({ seed: 101 }), 400);
    expect(s.snake.length).toBe(3 + s.score);
  });

  it('ignores a 180 degree reversal, goes straight and counts it', () => {
    const cfg = defaultConfig();
    const s = step(createGame(cfg), 'LEFT', cfg);
    expect(s.dir).toBe('RIGHT');
    expect(s.rejectedReversal).toBe(1);
    expect(s.snake[0]).toEqual([11, 10]);
  });

  it('kills the snake at the wall', () => {
    const cfg = defaultConfig({ w: 12, h: 12 });
    let s = createGame(cfg);
    while (s.alive) s = step(s, 'RIGHT', cfg);
    expect(s.endReason).toBe('death');
  });

  it('treats a null answer as carry straight on', () => {
    const cfg = defaultConfig();
    const s = step(createGame(cfg), null, cfg);
    expect(s.dir).toBe('RIGHT');
    expect(s.rejectedReversal).toBe(0);
  });
});

describe('level 2', () => {
  const cfg = (seed: number) => defaultConfig({ level: 2, obstacleCount: 8, seed });

  it('is identical for the same seed and differs across seeds', () => {
    expect(createGame(cfg(101)).obstacles).toEqual(createGame(cfg(101)).obstacles);
    expect(createGame(cfg(101)).obstacles).not.toEqual(createGame(cfg(102)).obstacles);
  });

  it('keeps obstacles clear of the start path and the food reachable', () => {
    for (const seed of [101, 102, 103]) {
      const c = cfg(seed);
      const s = createGame(c);
      expect(s.obstacles).toHaveLength(8);
      for (const o of s.obstacles) {
        expect(Math.max(Math.abs(o[0] - 10), Math.abs(o[1] - 10))).toBeGreaterThan(2);
      }
      expect(bfsDistance(s, c, s.snake[0], s.food!)).not.toBeNull();
    }
  });
});
