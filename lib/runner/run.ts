import {
  bfsDistance, createGame, deadlineAt, end, nextCell, safeMoves, speedCpsAt, step,
  type Cell, type Config, type Dir, type State,
} from '@/lib/game/engine';
import { promptVersion, type ClockMode } from '@/lib/decide/prompt';
import { now, sleep, type Adapter, type Decision } from '@/lib/decide/adapters';
import {
  callCost, deadlineBreakpoint, percentile, summarizeRun,
  type DecisionRecord, type DecisionStatus, type Price, type RunMeta, type RunRecord,
} from '@/lib/metrics/metrics';

export class BudgetError extends Error {
  constructor(public readonly kind: 'run' | 'model' | 'hard') {
    super(`budget cap reached (${kind})`);
  }
}

export class FatalProviderError extends Error {}

export interface BudgetGuard {
  hardCapUsd: number;
  maxUsdPerRun: number;
  maxUsdPerModel: number;
  spent: number;
  byModel: Record<string, number>;
}

export const newBudget = (over: Partial<BudgetGuard> = {}): BudgetGuard => ({
  hardCapUsd: Number(process.env.BUDGET_USD_HARD_CAP ?? 1),
  maxUsdPerRun: Infinity,
  maxUsdPerModel: Infinity,
  spent: 0,
  byModel: {},
  ...over,
});

/** Checked before every call, with the worst case of the call that is about to happen. */
function assertBudget(b: BudgetGuard, model: string, upcomingUsd: number) {
  const projected = b.spent + upcomingUsd;
  if (projected > b.hardCapUsd) throw new BudgetError('hard');
  if (projected > b.maxUsdPerRun) throw new BudgetError('run');
  if ((b.byModel[model] ?? 0) + upcomingUsd > b.maxUsdPerModel) throw new BudgetError('model');
}

const charge = (b: BudgetGuard, model: string, usd: number) => {
  b.spent += usd;
  b.byModel[model] = (b.byModel[model] ?? 0) + usd;
};

export interface Frame {
  tick: number;
  score: number;
  dir: Dir;
  snake: Cell[];
  food: Cell | null;
  deadline_ms: number | null;
  status: DecisionStatus;
  latency_ms: number | null;
}

export interface Replay {
  run_id: string;
  meta: RunMeta;
  config: Config;
  obstacles: Cell[];
  frames: Frame[];
  decisions: DecisionRecord[];
}

export type RunEvent =
  | { type: 'pending'; tick: number; deadline_ms: number | null; started_at: number }
  | { type: 'decision'; decision: DecisionRecord; state: State }
  | { type: 'end'; run: RunRecord };

export interface RunOptions {
  cfg: Config;
  adapter: Adapter;
  mode: ClockMode;
  hints: boolean;
  meta: Omit<RunMeta, 'prompt_version' | 'mode' | 'hints' | 'seed' | 'level' | 'grid' | 'base_deadline_ms' | 'min_deadline_ms' | 'pace_factor'>;
  price?: Price | null;
  maxTokens?: number;
  turnTimeoutMs?: number;
  displayMinTickMs?: number;
  budget?: BudgetGuard;
  /** Reference p50 for the predicted breakpoint; defaults to this run's own p50. */
  turnP50Ms?: number;
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
}

const FATAL = /401|403|unauthorized|forbidden|api key|credit|quota|insufficient|out_of_credits/i;

export async function runGame(opts: RunOptions): Promise<{ run: RunRecord; decisions: DecisionRecord[]; replay: Replay }> {
  const { cfg, adapter, mode, hints } = opts;
  const budget = opts.budget ?? newBudget();
  const maxTokens = opts.maxTokens ?? 16;
  const price = opts.price ?? null;
  const displayMinTickMs = opts.displayMinTickMs ?? 0;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 30_000;

  const meta: RunMeta = {
    ...opts.meta,
    mode,
    hints,
    seed: cfg.seed,
    level: cfg.level,
    grid: `${cfg.w}x${cfg.h}`,
    base_deadline_ms: cfg.baseDeadlineMs,
    min_deadline_ms: cfg.minDeadlineMs,
    pace_factor: cfg.paceFactor,
    prompt_version: promptVersion(mode, hints),
  };

  await adapter.warmup?.(cfg);

  let state = createGame(cfg);
  const decisions: DecisionRecord[] = [];
  const frames: Frame[] = [];
  const obstacles = state.obstacles;

  const foodPathLengths: number[] = [];
  const foodTickCosts: number[] = [];
  const foodSecondCosts: number[] = [];
  let foodStartTick = 0;
  let foodStartMs = 0;
  if (state.food) foodPathLengths.push(bfsDistance(state, cfg, state.snake[0], state.food) ?? 0);

  const started = now();
  let consecutiveErrors = 0;
  let deadlineAtDeathMs: number | null = null;
  let inFlight: Promise<void> | null = null;
  const freerun: { landed: { move: Dir | null; record: DecisionRecord } | null } = { landed: null };

  /** Fires one request. Never more than one is outstanding — the caller awaits or parks it. */
  const dispatch = async (snapshot: State, deadlineMs: number | null): Promise<{ decision: Decision | null; record: DecisionRecord }> => {
    const worstCase = adapter.paid ? callCost(price, estimateInputTokens(cfg, snapshot), maxTokens) : 0;
    assertBudget(budget, adapter.id, worstCase);

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const limit = mode === 'deadline' ? deadlineMs! : mode === 'turn' ? turnTimeoutMs : null;
    const timer = limit === null ? null : setTimeout(() => controller.abort(new Error('deadline')), limit);

    opts.onEvent?.({ type: 'pending', tick: snapshot.tick, deadline_ms: deadlineMs, started_at: now() });

    const t0 = now();
    let decision: Decision | null = null;
    let status: DecisionStatus = 'ok';
    let error: string | null = null;
    try {
      decision = await adapter.decide({ state: snapshot, cfg, mode, hints, signal: controller.signal });
      if (decision.move === null) status = 'invalid';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted && !opts.signal?.aborted) status = 'timeout';
      else if (opts.signal?.aborted) throw e;
      else {
        status = 'error';
        error = message;
        if (FATAL.test(message)) {
          clearTimeout(timer ?? undefined);
          opts.signal?.removeEventListener('abort', onOuterAbort);
          throw new FatalProviderError(message);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    const t1 = now();
    const usage = decision?.usage ?? null;
    const aborted = status === 'timeout';
    const tokensIn = usage?.input ?? (aborted && adapter.paid ? estimateInputTokens(cfg, snapshot) : null);
    const tokensOut = usage?.output ?? (aborted && adapter.paid ? maxTokens : null);
    const costEstimated = usage === null ? aborted && adapter.paid : usage.estimated;
    const cost = adapter.paid && status !== 'error' ? callCost(price, tokensIn, tokensOut) : 0;
    charge(budget, adapter.id, cost);

    const latency = status === 'ok' ? t1 - t0 : null;
    const ttft = decision?.timing.tFirstToken !== null && decision?.timing.tFirstToken !== undefined
      ? decision.timing.tFirstToken - decision.timing.tRequestSent : null;
    const callMs = status === 'ok' ? t1 - t0 : null;
    const streamed = adapter.streams && ttft !== null && callMs !== null && callMs > ttft;
    const head = snapshot.snake[0];

    const record: DecisionRecord = {
      run_id: meta.run_id,
      tick: snapshot.tick,
      score: snapshot.score,
      deadline_ms: deadlineMs === null ? null : Math.round(deadlineMs),
      move: decision?.move ?? null,
      latency_ms: latency === null ? null : round2(latency),
      timed_out: status === 'timeout',
      censored_at_ms: status === 'timeout' ? Math.round(limit ?? 0) : null,
      status,
      ttft_ms: round2(ttft),
      call_ms: round2(callMs),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_reasoning: usage?.reasoning ?? null,
      tokens_total: usage?.total ?? null,
      tokens_per_sec: tokensOut && callMs ? round2((tokensOut / (streamed ? callMs - ttft! : callMs)) * 1000) : null,
      tokens_per_sec_basis: tokensOut && callMs ? (streamed ? 'first_token' : 'call_duration') : null,
      cost_usd: cost,
      cost_estimated: costEstimated,
      gateway_cost_usd: decision?.gatewayCostUsd ?? null,
      safe: decision?.move ? safeMoves(snapshot, cfg).includes(decision.move) : null,
      food_delta: decision?.move && snapshot.food ? foodDelta(snapshot, cfg, head, decision.move, snapshot.food) : null,
      staleness_ticks: null,
      confidence: decision?.confidence ?? null,
      error,
      raw: decision?.raw ?? error ?? '',
    };
    return { decision: status === 'ok' ? decision : null, record };
  };

  const advance = (move: Dir | null, record: DecisionRecord | null) => {
    const before = state.score;
    state = step(state, move, cfg);
    if (record) decisions.push(record);
    frames.push({
      tick: state.tick, score: state.score, dir: state.dir, snake: state.snake,
      food: state.food, deadline_ms: record?.deadline_ms ?? null,
      status: record?.status ?? 'ok', latency_ms: record?.latency_ms ?? null,
    });
    if (state.score > before) {
      foodTickCosts.push(state.tick - foodStartTick);
      foodSecondCosts.push((now() - (foodStartMs || started)) / 1000);
      foodStartTick = state.tick;
      foodStartMs = now();
      if (state.food) foodPathLengths.push(bfsDistance(state, cfg, state.snake[0], state.food) ?? 0);
    }
    if (record) opts.onEvent?.({ type: 'decision', decision: record, state });
  };

  try {
    while (state.alive) {
      if ((now() - started) / 1000 >= cfg.maxGameSeconds) { state = end(state, 'time_limit'); break; }
      if (decisions.length >= cfg.maxCallsPerGame) { state = end(state, 'call_cap'); break; }
      if (opts.signal?.aborted) { state = end(state, 'aborted'); break; }

      const tickStart = now();
      const deadlineMs = mode === 'deadline' ? deadlineAt(state.score, cfg) : null;
      deadlineAtDeathMs = deadlineAt(state.score, cfg);

      if (mode === 'freerun') {
        const tickMs = 1000 / speedCpsAt(state.score, cfg);
        if (!inFlight) {
          const snapshot = state;
          inFlight = dispatch(snapshot, null).then((r) => {
            r.record.staleness_ticks = state.tick - snapshot.tick;
            freerun.landed = { move: r.decision?.move ?? null, record: r.record };
            inFlight = null;
          });
        }
        const reply = freerun.landed;
        freerun.landed = null;
        advance(reply?.move ?? null, reply?.record ?? null);
        await pause(tickMs);
        continue;
      }

      const { decision, record } = await dispatch(state, deadlineMs);
      if (record.status === 'error') consecutiveErrors++;
      else consecutiveErrors = 0;
      advance(decision?.move ?? null, record);
      if (consecutiveErrors >= 3) { state = end(state, 'errors'); break; }

      const spent = now() - tickStart;
      if (displayMinTickMs > spent) await pause(displayMinTickMs - spent);
    }
  } catch (e) {
    if (e instanceof BudgetError) state = end(state, 'budget_cap');
    else if (e instanceof FatalProviderError) { state = end(state, 'errors'); throw Object.assign(e, { partial: true }); }
    else throw e;
  }

  const latencies = decisions.filter((d) => d.status === 'ok' && d.latency_ms !== null).map((d) => d.latency_ms!);
  const reference = opts.turnP50Ms ?? percentile(latencies, 50);
  const run = summarizeRun(meta, decisions, {
    score: state.score,
    finalLength: state.snake.length,
    survivalSeconds: (now() - started) / 1000,
    survivalTicks: state.tick,
    endReason: state.endReason,
    rejectedReversal: state.rejectedReversal,
    deadlineAtDeathMs,
    foodPathLengths: foodPathLengths.slice(0, foodTickCosts.length),
    foodTickCosts,
    foodSecondCosts,
    predictedBreakpointK: reference === null ? null : deadlineBreakpoint(cfg, reference),
  });

  opts.onEvent?.({ type: 'end', run });
  return { run, decisions, replay: { run_id: meta.run_id, meta, config: cfg, obstacles, frames, decisions } };
}

const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** Wall-clock pacing that happens after a move is applied, so it cannot touch any latency. */
const pause = (ms: number) => sleep(ms, new AbortController().signal);

/** Prompt plus state, at the usual ~4 characters per token. Used only for worst-case budgeting. */
const estimateInputTokens = (cfg: Config, s: State) =>
  Math.ceil((600 + JSON.stringify(s.snake).length + JSON.stringify(s.obstacles).length) / 4);

function foodDelta(s: State, cfg: Config, head: Cell, move: Dir, food: Cell): number | null {
  const before = bfsDistance(s, cfg, head, food);
  const after = bfsDistance(s, cfg, nextCell(head, move), food);
  return before === null || after === null ? null : after - before;
}
