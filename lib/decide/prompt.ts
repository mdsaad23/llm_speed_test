import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bfsDistance, deadlineAt, nextCell, safeMoves, speedCpsAt, type Cell, type Config, type Dir, type State } from '@/lib/game/engine';

export type ClockMode = 'deadline' | 'turn' | 'freerun';

export const moveSchema = z.object({
  move: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']),
});

const RULES = [
  'You are playing Snake on a grid. x grows to the right, y grows downward, (0,0) is the top-left cell.',
  'You die if your head enters a wall, an obstacle, or any square your own body occupies.',
  'You cannot reverse 180 degrees. A reversal is ignored and you carry straight on.',
  'Eating the food scores +1, grows you by one square, and shortens the time limit for every later move.',
  'Your goal is to survive and to reach the food in as few moves as possible.',
].join('\n');

const CLOCK: Record<ClockMode, string> = {
  deadline:
    'The board is frozen while you decide. An answer that arrives later than deadline_ms is thrown away and the snake steps straight ahead, so answer immediately with nothing but the move.',
  turn:
    'The board is frozen while you decide and it waits for your answer. Answer with nothing but the move.',
  freerun:
    'The board is NOT frozen: the snake keeps moving at speed_cps while you think, and your answer is applied on the tick after it arrives. Answer immediately with nothing but the move.',
};

const ANSWER = 'Answer with one move: UP, DOWN, LEFT or RIGHT.';

export const systemPrompt = (mode: ClockMode) => `${RULES}\n${CLOCK[mode]}\n${ANSWER}`;

export const promptVersion = (mode: ClockMode, hints: boolean) =>
  createHash('sha256')
    .update(`${systemPrompt(mode)}\n${JSON.stringify(z.toJSONSchema(moveSchema))}\nhints=${hints}`)
    .digest('hex')
    .slice(0, 12);

/** Compact numbers only, no prose, sent last so a cached static prefix keeps hitting. */
export function stateJson(s: State, cfg: Config, mode: ClockMode, hints: boolean): string {
  const body: Record<string, unknown> = {
    grid: { w: cfg.w, h: cfg.h },
    tick: s.tick,
    score: s.score,
  };
  if (mode === 'deadline') body.deadline_ms = Math.round(deadlineAt(s.score, cfg));
  if (mode === 'freerun') {
    body.speed_cps = Number(speedCpsAt(s.score, cfg).toFixed(3));
    body.tick_ms = Math.round(1000 / speedCpsAt(s.score, cfg));
  }
  body.dir = s.dir;
  body.snake = s.snake;
  body.food = s.food;
  body.obstacles = s.obstacles;
  if (hints) Object.assign(body, hintFields(s, cfg));
  return JSON.stringify(body);
}

function hintFields(s: State, cfg: Config) {
  const safe = safeMoves(s, cfg);
  const head = s.snake[0];
  const toward: Record<string, number | null> = {};
  for (const d of ['UP', 'DOWN', 'LEFT', 'RIGHT'] as Dir[]) {
    toward[d] = s.food ? distanceDelta(s, cfg, head, nextCell(head, d), s.food) : null;
  }
  return {
    safe: Object.fromEntries((['UP', 'DOWN', 'LEFT', 'RIGHT'] as Dir[]).map((d) => [d, safe.includes(d)])),
    food_delta: toward,
  };
}

function distanceDelta(s: State, cfg: Config, from: Cell, to: Cell, food: Cell): number | null {
  const before = bfsDistance(s, cfg, from, food);
  const after = bfsDistance(s, cfg, to, food);
  return before === null || after === null ? null : after - before;
}
