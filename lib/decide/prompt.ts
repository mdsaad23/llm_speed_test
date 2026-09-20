import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DIRS, bfsDistance, deadlineAt, nextCell, opposite, safeMoves, speedCpsAt, type Cell, type Config, type Dir, type State } from '@/lib/game/engine';

export type ClockMode = 'deadline' | 'turn' | 'freerun';

/** Permissive: what a reply is parsed against, so an off-grammar reversal is recorded, not dropped. */
export const moveSchema = z.object({
  move: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']),
});

export const legalMoves = (dir: Dir): Dir[] => DIRS.filter((d) => d !== opposite(dir));

/** What a reply is *asked* for. The reversal is left out, so a constrained decoder cannot emit it. */
export const moveSchemaFor = (dir: Dir) =>
  z.object({ move: z.enum(legalMoves(dir) as [Dir, ...Dir[]]) });

/** Absolute, not relative to the heading — the confusion that made models answer their own neck. */
export const MOVE_MEANING: Record<Dir, string> = {
  UP: 'Move the head one cell up (y - 1).',
  DOWN: 'Move the head one cell down (y + 1).',
  LEFT: 'Move the head one cell left (x - 1).',
  RIGHT: 'Move the head one cell right (x + 1).',
};

const RULES = [
  'You are playing Snake on a grid. x grows to the right, y grows downward, (0,0) is the top-left cell.',
  'The four moves are absolute compass directions on that grid, never relative to the way you are facing: UP is y-1, DOWN is y+1, LEFT is x-1, RIGHT is x+1.',
  'You die if your head enters a wall, an obstacle, or any square your own body occupies.',
  'You are travelling in direction dir. Its opposite is illegal_move: a 180 degree reversal straight into your own neck. It is not on the menu, and sending it anyway is ignored — you carry on in dir and lose the turn.',
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

const ANSWER = 'Answer with one of the three moves offered, and never with illegal_move.';

export const systemPrompt = (mode: ClockMode) => `${RULES}\n${CLOCK[mode]}\n${ANSWER}`;

/** RIGHT is the start heading, so its schema stands in for the shape every turn is offered. */
export const promptVersion = (mode: ClockMode, hints: boolean) =>
  createHash('sha256')
    .update(`${systemPrompt(mode)}\n${JSON.stringify(z.toJSONSchema(moveSchemaFor('RIGHT')))}\nhints=${hints}`)
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
  body.illegal_move = opposite(s.dir);
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
  for (const d of legalMoves(s.dir)) {
    toward[d] = s.food ? distanceDelta(s, cfg, head, nextCell(head, d), s.food) : null;
  }
  return {
    safe: Object.fromEntries(legalMoves(s.dir).map((d) => [d, safe.includes(d)])),
    food_delta: toward,
  };
}

function distanceDelta(s: State, cfg: Config, from: Cell, to: Cell, food: Cell): number | null {
  const before = bfsDistance(s, cfg, from, food);
  const after = bfsDistance(s, cfg, to, food);
  return before === null || after === null ? null : after - before;
}
