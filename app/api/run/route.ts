import { z } from 'zod';
import { createGame, defaultConfig, isOfficial, type Config, type State } from '@/lib/game/engine';
import { byokEntry, createAdapter, findModel, type ModelEntry } from '@/lib/decide/models.config';
import { PROVIDERS, envKey, isProviderId } from '@/lib/decide/providers';
import { recordBest } from '@/lib/metrics/leaderboard';
import { writeResults } from '@/lib/metrics/results';
import { newBudget, runGame, type RunEvent } from '@/lib/runner/run';

export const runtime = 'nodejs';
// Vercel's ceiling on every plan. A game is cut to HOSTED_MAX_GAME_SECONDS so its last
// 30s model call and the leaderboard write still land inside it.
export const maxDuration = 300;
const HOSTED_MAX_GAME_SECONDS = 260;

const body = z.object({
  model: z.string(),
  /** Set together: the caller's own provider and key, which never leave this request. */
  provider: z.string().optional(),
  apiKey: z.string().optional(),
  mode: z.enum(['deadline', 'turn', 'freerun']),
  hints: z.boolean(),
  try: z.int().min(1).max(20),
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

  let entry: ModelEntry;
  let apiKey = opts.apiKey ?? '';
  if (opts.provider) {
    if (!isProviderId(opts.provider)) return Response.json({ error: `unknown provider "${opts.provider}"` }, { status: 400 });
    apiKey ||= envKey(opts.provider);
    if (!apiKey) return Response.json({ error: `${PROVIDERS[opts.provider].label} needs an API key` }, { status: 400 });
    entry = byokEntry(opts.provider, opts.model);
  } else {
    try {
      entry = findModel(opts.model);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    // Models billed to the server's own key stay on the CLI, where the typed confirmation lives.
    if (entry.paid) return Response.json({ error: `"${entry.id}" is paid: run it with pnpm bench` }, { status: 400 });
  }

  // Decided here, not by the caller: the leaderboard trusts this flag.
  const manual = !isOfficial(defaultConfig(opts.cfg), opts.mode, opts.hints);
  const cfg = defaultConfig({
    ...opts.cfg,
    maxGameSeconds: process.env.VERCEL ? Math.min(opts.cfg.maxGameSeconds, HOSTED_MAX_GAME_SECONDS) : opts.cfg.maxGameSeconds,
  });
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
    manual,
    manual_params: manual ? { ...opts.cfg, displayMinTickMs: opts.displayMinTickMs } : undefined,
  };

  const adapter = createAdapter(entry, cfg.seed, apiKey);
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
        // Vercel's disk is read-only: hosted runs keep only what beats the leaderboard.
        if (!process.env.VERCEL) writeResults([run], decisions, [replay], { includeFreerun: false, includeManual: false });
        // Mock and baselines are not models: they would sit on top of a board built to compare models.
        if (!manual && entry.provider !== 'mock' && entry.provider !== 'baseline') await recordBest(run);
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
