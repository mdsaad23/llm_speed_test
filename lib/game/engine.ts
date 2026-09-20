export type Dir = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
export type Cell = [number, number];

export const DIRS = ['UP', 'DOWN', 'LEFT', 'RIGHT'] as const;
const STEP: Record<Dir, Cell> = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
const OPPOSITE: Record<Dir, Dir> = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

export interface Config {
  w: number;
  h: number;
  level: 1 | 2;
  obstacleCount: number;
  seed: number;
  baseDeadlineMs: number;
  minDeadlineMs: number;
  paceFactor: number;
  baseSpeedCps: number;
  maxGameSeconds: number;
  maxCallsPerGame: number;
}

export const defaultConfig = (over: Partial<Config> = {}): Config => ({
  w: 20, h: 20, level: 1, obstacleCount: 8, seed: 101,
  baseDeadlineMs: 8000, minDeadlineMs: 250, paceFactor: 1.05,
  baseSpeedCps: 2, maxGameSeconds: 300, maxCallsPerGame: 300,
  ...over,
});

export type EndReason =
  | 'death' | 'grid_full' | 'time_limit' | 'stall'
  | 'call_cap' | 'budget_cap' | 'errors' | 'aborted';

export interface State {
  tick: number;
  score: number;
  dir: Dir;
  snake: Cell[];
  food: Cell | null;
  obstacles: Cell[];
  rng: number;
  ticksSinceFood: number;
  rejectedReversal: number;
  alive: boolean;
  endReason: EndReason | null;
}

const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1];
const has = (cells: Cell[], c: Cell) => cells.some((x) => same(x, c));

/** mulberry32, threaded through state so step stays pure. */
function rand(seed: number): [number, number] {
  const t = (seed + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return [t, ((r ^ (r >>> 14)) >>> 0) / 4294967296];
}

export const paceFactorAt = (score: number, cfg: Config) => cfg.paceFactor ** score;
export const deadlineAt = (score: number, cfg: Config) =>
  Math.max(cfg.minDeadlineMs, cfg.baseDeadlineMs / paceFactorAt(score, cfg));
export const speedCpsAt = (score: number, cfg: Config) => cfg.baseSpeedCps * paceFactorAt(score, cfg);
export const stallLimit = (cfg: Config) => 3 * cfg.w * cfg.h;

function startSnake(cfg: Config): Cell[] {
  const x = Math.floor(cfg.w / 2);
  const y = Math.floor(cfg.h / 2);
  return [[x, y], [x - 1, y], [x - 2, y]];
}

function freeCells(cfg: Config, snake: Cell[], obstacles: Cell[]): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < cfg.h; y++) {
    for (let x = 0; x < cfg.w; x++) {
      const c: Cell = [x, y];
      if (!has(snake, c) && !has(obstacles, c)) out.push(c);
    }
  }
  return out;
}

function placeFood(cfg: Config, snake: Cell[], obstacles: Cell[], rng: number): [Cell | null, number] {
  const free = freeCells(cfg, snake, obstacles);
  if (free.length === 0) return [null, rng];
  const [next, r] = rand(rng);
  return [free[Math.floor(r * free.length)], next];
}

/** Every cell the snake occupies plus the five it would cross going straight. */
function startPath(cfg: Config, snake: Cell[]): Cell[] {
  const path: Cell[] = [...snake];
  for (let i = 1; i <= 5; i++) path.push([snake[0][0] + i, snake[0][1]]);
  return path.filter(([x, y]) => x >= 0 && y >= 0 && x < cfg.w && y < cfg.h);
}

/** Free cells (snake squares count as free — the snake moves) must form one region. */
function connected(cfg: Config, obstacles: Cell[]): boolean {
  const blocked = new Set(obstacles.map(([x, y]) => y * cfg.w + x));
  const total = cfg.w * cfg.h - blocked.size;
  const start = startSnake(cfg)[0];
  const seen = new Set<number>([start[1] * cfg.w + start[0]]);
  const queue: Cell[] = [start];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const d of DIRS) {
      const nx = x + STEP[d][0];
      const ny = y + STEP[d][1];
      const id = ny * cfg.w + nx;
      if (nx < 0 || ny < 0 || nx >= cfg.w || ny >= cfg.h) continue;
      if (blocked.has(id) || seen.has(id)) continue;
      seen.add(id);
      queue.push([nx, ny]);
    }
  }
  return seen.size === total;
}

function generateObstacles(cfg: Config): [Cell[], number] {
  if (cfg.level === 1 || cfg.obstacleCount === 0) return [[], cfg.seed];
  const banned = startPath(cfg, startSnake(cfg));
  const nearStart = (c: Cell) =>
    banned.some((b) => Math.max(Math.abs(b[0] - c[0]), Math.abs(b[1] - c[1])) <= 2);

  let rng = cfg.seed;
  for (let attempt = 0; attempt < 200; attempt++) {
    const picked: Cell[] = [];
    for (let guard = 0; picked.length < cfg.obstacleCount && guard < 5000; guard++) {
      const [next, r] = rand(rng);
      rng = next;
      const i = Math.floor(r * cfg.w * cfg.h);
      const c: Cell = [i % cfg.w, Math.floor(i / cfg.w)];
      if (!nearStart(c) && !has(picked, c)) picked.push(c);
    }
    if (picked.length === cfg.obstacleCount && connected(cfg, picked)) return [picked, rng];
  }
  throw new Error(`cannot place ${cfg.obstacleCount} obstacles on ${cfg.w}x${cfg.h} seed ${cfg.seed}`);
}

export function createGame(cfg: Config): State {
  const snake = startSnake(cfg);
  const [obstacles, rngAfterLevel] = generateObstacles(cfg);
  const [food, rng] = placeFood(cfg, snake, obstacles, rngAfterLevel);
  return {
    tick: 0, score: 0, dir: 'RIGHT', snake, food, obstacles, rng,
    ticksSinceFood: 0, rejectedReversal: 0, alive: true, endReason: null,
  };
}

/** move === null means "no usable answer" — the snake carries on straight. */
export function step(s: State, move: Dir | null, cfg: Config): State {
  if (!s.alive) return s;

  let dir = s.dir;
  let rejectedReversal = s.rejectedReversal;
  if (move !== null && move !== s.dir) {
    if (move === OPPOSITE[s.dir]) rejectedReversal++;
    else dir = move;
  }

  const [dx, dy] = STEP[dir];
  const head: Cell = [s.snake[0][0] + dx, s.snake[0][1] + dy];
  const eats = s.food !== null && same(head, s.food);
  const body = eats ? s.snake : s.snake.slice(0, -1);
  const next: State = { ...s, tick: s.tick + 1, dir, rejectedReversal };

  const dead =
    head[0] < 0 || head[1] < 0 || head[0] >= cfg.w || head[1] >= cfg.h ||
    has(s.obstacles, head) || has(body, head);
  if (dead) return { ...next, alive: false, endReason: 'death' };

  next.snake = [head, ...body];
  if (eats) {
    next.score = s.score + 1;
    next.ticksSinceFood = 0;
    const [food, rng] = placeFood(cfg, next.snake, next.obstacles, s.rng);
    next.food = food;
    next.rng = rng;
    if (food === null) return { ...next, alive: false, endReason: 'grid_full' };
  } else {
    next.ticksSinceFood = s.ticksSinceFood + 1;
    if (next.ticksSinceFood >= stallLimit(cfg)) return { ...next, alive: false, endReason: 'stall' };
  }
  return next;
}

export const end = (s: State, reason: EndReason): State =>
  s.alive ? { ...s, alive: false, endReason: reason } : s;

export const nextCell = (from: Cell, d: Dir): Cell => [from[0] + STEP[d][0], from[1] + STEP[d][1]];

export const opposite = (d: Dir): Dir => OPPOSITE[d];

const blocked = (s: State, cfg: Config, c: Cell) =>
  c[0] < 0 || c[1] < 0 || c[0] >= cfg.w || c[1] >= cfg.h ||
  has(s.obstacles, c) || has(s.snake.slice(0, -1), c);

export const safeMoves = (s: State, cfg: Config): Dir[] =>
  DIRS.filter((d) => d !== OPPOSITE[s.dir] && !blocked(s, cfg, nextCell(s.snake[0], d)));

/** Shortest path length over cells the snake could legally occupy; null when unreachable. */
export function bfsDistance(s: State, cfg: Config, from: Cell, to: Cell): number | null {
  const walls = new Set([...s.obstacles, ...s.snake.slice(0, -1)].map(([x, y]) => y * cfg.w + x));
  const id = (c: Cell) => c[1] * cfg.w + c[0];
  const dist = new Map<number, number>([[id(from), 0]]);
  const queue: Cell[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (same(cur, to)) return dist.get(id(cur))!;
    for (const d of DIRS) {
      const n = nextCell(cur, d);
      if (n[0] < 0 || n[1] < 0 || n[0] >= cfg.w || n[1] >= cfg.h) continue;
      if (dist.has(id(n)) || (walls.has(id(n)) && !same(n, to))) continue;
      dist.set(id(n), dist.get(id(cur))! + 1);
      queue.push(n);
    }
  }
  return null;
}
