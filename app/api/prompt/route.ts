import { z } from 'zod';
import { createGame, defaultConfig } from '@/lib/game/engine';
import { moveSchemaFor, promptVersion, stateJson, systemPrompt } from '@/lib/decide/prompt';

export const runtime = 'nodejs';

const num = (min: number, max: number, dflt: number) => z.coerce.number().min(min).max(max).catch(dflt);
const base = defaultConfig();

const query = z.object({
  mode: z.enum(['deadline', 'turn', 'freerun']).catch('deadline'),
  hints: z.enum(['true', 'false']).catch('false'),
  w: num(5, 60, base.w),
  h: num(5, 60, base.h),
  level: z.coerce.number().int().min(1).max(2).catch(base.level),
  obstacleCount: num(0, 200, base.obstacleCount),
  seed: z.coerce.number().int().catch(base.seed),
  baseDeadlineMs: num(50, 60_000, base.baseDeadlineMs),
  minDeadlineMs: num(10, 60_000, base.minDeadlineMs),
  paceFactor: num(1, 2, base.paceFactor),
  baseSpeedCps: num(0.1, 60, base.baseSpeedCps),
});

/** What the model actually receives, rendered from the first tick of the configured board. */
export function GET(req: Request) {
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  const { mode, hints: hintsRaw, ...over } = q;
  const hints = hintsRaw === 'true';
  const cfg = defaultConfig({ ...over, level: over.level as 1 | 2 });

  const state = createGame(cfg);

  return Response.json({
    system: systemPrompt(mode),
    example: stateJson(state, cfg, mode, hints),
    schema: JSON.stringify(z.toJSONSchema(moveSchemaFor(state.dir)), null, 2),
    version: promptVersion(mode, hints),
  });
}
