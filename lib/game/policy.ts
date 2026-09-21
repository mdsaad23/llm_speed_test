import {
  DIRS, bfsDistance, createGame, nextCell, safeMoves, step,
  type Cell, type Config, type Dir, type State,
} from '@/lib/game/engine';

/** Free cells reachable from a square — used to avoid walking into a pocket. */
function openArea(s: State, cfg: Config, from: Cell): number {
  const walls = new Set([...s.obstacles, ...s.snake.slice(0, -1)].map(([x, y]) => y * cfg.w + x));
  const seen = new Set<number>([from[1] * cfg.w + from[0]]);
  const queue: Cell[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const d of DIRS) {
      const n = nextCell(cur, d);
      const id = n[1] * cfg.w + n[0];
      if (n[0] < 0 || n[1] < 0 || n[0] >= cfg.w || n[1] >= cfg.h) continue;
      if (walls.has(id) || seen.has(id)) continue;
      seen.add(id);
      queue.push(n);
    }
  }
  return seen.size;
}

/**
 * The reference policy: of the safe moves, the one closest to the food by BFS, ties broken by the
 * room it leaves behind. Pure and instant, so it can be asked what it would have done on any board
 * without costing a call. `null` means trapped — every move kills.
 */
export function greedyMove(s: State, cfg: Config): Dir | null {
  const safe = safeMoves(s, cfg);
  if (!safe.length) return null;
  const scored = safe.map((d) => {
    const cell = nextCell(s.snake[0], d);
    return { d, toFood: s.food ? bfsDistance(s, cfg, cell, s.food) : null, area: openArea(s, cfg, cell) };
  });
  scored.sort((a, b) => {
    if (a.toFood !== b.toFood) {
      if (a.toFood === null) return 1;
      if (b.toFood === null) return -1;
      return a.toFood - b.toFood;
    }
    return b.area - a.area;
  });
  return scored[0].d;
}

const memo = new Map<string, number>();

/**
 * What `greedyMove` scores on this exact board: the denominator for `score_normalized`.
 *
 * Deliberately blind to `maxGameSeconds` — a policy that answers in microseconds would never hit a
 * wall-clock limit, and reading one would make the denominator depend on how busy the machine was.
 * Only the caps that shape the board and the game length are honoured, so the answer is a pure
 * function of the config and safe to memoize.
 */
export function baselineScore(cfg: Config): number {
  const key = [cfg.w, cfg.h, cfg.level, cfg.obstacleCount, cfg.seed, cfg.maxCallsPerGame].join(':');
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  let s = createGame(cfg);
  for (let calls = 0; s.alive && calls < cfg.maxCallsPerGame; calls++) s = step(s, greedyMove(s, cfg), cfg);
  memo.set(key, s.score);
  return s.score;
}
