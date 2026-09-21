import { describe, expect, it } from 'vitest';
import { createGame, defaultConfig, safeMoves, step } from '@/lib/game/engine';
import { baselineScore, greedyMove } from '@/lib/game/policy';

describe('greedyMove', () => {
  it('never answers its own neck and never a move it knows kills', () => {
    const cfg = defaultConfig({ seed: 101 });
    let s = createGame(cfg);
    for (let i = 0; i < 120 && s.alive; i++) {
      const move = greedyMove(s, cfg);
      if (move === null) break;
      expect(safeMoves(s, cfg)).toContain(move);
      s = step(s, move, cfg);
    }
  });

  it('closes on the food when the way is open', () => {
    const cfg = defaultConfig({ w: 9, h: 9, level: 1, seed: 101 });
    const s = { ...createGame(cfg), snake: [[4, 4], [3, 4], [2, 4]] as [number, number][], food: [4, 1] as [number, number] };
    expect(greedyMove(s, cfg)).toBe('UP');
  });
});

describe('baselineScore', () => {
  it('is the same answer every time for the same board', () => {
    const cfg = defaultConfig({ seed: 101 });
    expect(baselineScore(cfg)).toBe(baselineScore(defaultConfig({ seed: 101 })));
  });

  it('scores something a model has to beat', () => {
    expect(baselineScore(defaultConfig({ seed: 101 }))).toBeGreaterThan(0);
  });

  it('depends on the board, not on the clock', () => {
    const fast = defaultConfig({ seed: 101, baseDeadlineMs: 50, maxGameSeconds: 1 });
    expect(baselineScore(fast)).toBe(baselineScore(defaultConfig({ seed: 101 })));
  });

  it('separates a different board', () => {
    const a = baselineScore(defaultConfig({ seed: 101, level: 2, obstacleCount: 8 }));
    const b = baselineScore(defaultConfig({ seed: 101, level: 1 }));
    expect(a).not.toBe(b);
  });
});
