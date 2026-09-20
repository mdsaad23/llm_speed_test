import { z } from 'zod';
import { createGame, defaultConfig, type Config, type State } from '@/lib/game/engine';
import { createAdapter, findModel } from '@/lib/decide/models.config';
import { writeResults } from '@/lib/metrics/results';
import { newBudget, runGame, type RunEvent } from '@/lib/runner/run';

export const runtime = 'nodejs';

const body = z.object({
  model: z.string(),
  mode: z.enum(['deadline', 'turn', 'freerun']),
  hints: z.boolean(),
  try: z.int().min(1).max(20),
  manual: z.boolean(),
  displayMinTickMs: z.number().min(0).max(2000),
  maxUsdPerRun: z.number().min(0).max(100),
  cfg: z.object({
    w: z.int().min(5).max(60),
    h: z.int().min(5).max(60),
    level: z.union([z.literal(1), z.literal(2)]),
    obstacleCount: z.int().min(0).max(200),
    seed: z.int(),
    baseDeadlineMs: z.number().min(50).max(60_000),
    minDeadlineMs: z.number().min(10).max(60_000),
    paceFactor: z.number().min(1).max(2),
    baseSpeedCps: z.number().min(0.1).max(60),
    maxGameSeconds: z.number().min(1).max(3600),
    maxCallsPerGame: z.int().min(1).max(5000),
  }),
});

export type StartEvent = { type: 'start'; cfg: Config; state: State; model: string; try: number };
export type UiEvent =
  | StartEvent
  | RunEvent
  | { type: 'warmup'; model: string }
  | { type: 'fatal'; message: string };

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const opts = parsed.data;

  let entry;
  try {
    entry = findModel(opts.model);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  // Paid models stay on the CLI, where the worst-case estimate and the typed confirmation live.
  if (entry.paid) return Response.json({ error: `"${entry.id}" is paid: run it with pnpm bench` }, { status: 400 });

  const cfg = defaultConfig(opts.cfg);
  const meta = {
    run_id: crypto.randomUUID(),
    model: entry.id,
    route: entry.route,
    reasoning: entry.reasoning,
    reasoning_requested: entry.reasoning,
    try: opts.try,
    timestamp: new Date().toISOString(),
    client_region: 'local',
    machine: {},
    manual: opts.manual,
    manual_params: opts.manual ? { ...opts.cfg, displayMinTickMs: opts.displayMinTickMs } : undefined,
  };

  const adapter = createAdapter(entry, cfg.seed);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: UiEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: 'start', cfg, state: createGame(cfg), model: entry.id, try: opts.try });
      // A cold 26B can take a minute to land in VRAM: say so rather than show a frozen board.
      if (adapter.warmup) send({ type: 'warmup', model: entry.id });
      try {
        const { run, decisions, replay } = await runGame({
          cfg,
          adapter,
          mode: opts.mode,
          hints: opts.hints,
          meta,
          maxTokens: entry.maxTokens,
          turnTimeoutMs: entry.timeoutMs,
          displayMinTickMs: opts.displayMinTickMs,
          budget: newBudget({ maxUsdPerRun: opts.maxUsdPerRun }),
          onEvent: send,
          signal: req.signal,
        });
        writeResults([run], decisions, [replay], { includeFreerun: false, includeManual: false });
      } catch (e) {
        send({ type: 'fatal', message: e instanceof Error ? e.message : String(e) });
      }
      await adapter.unload?.();
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}
