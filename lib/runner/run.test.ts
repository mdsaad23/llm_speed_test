import { describe, expect, it } from 'vitest';
import { defaultConfig, type Dir } from '@/lib/game/engine';
import { freeDecision, greedyAdapter, mockAdapter, now, sleep, type Adapter } from '@/lib/decide/adapters';
import { requirePrice } from '@/lib/decide/pricing';
import { newBudget, runGame } from '@/lib/runner/run';
import type { ModelEntry } from '@/lib/decide/models.config';

const meta = (run_id: string) => ({
  run_id,
  model: 'mock',
  route: 'mock',
  reasoning: 'none',
  reasoning_requested: 'none',
  try: 1,
  timestamp: '2026-09-20T00:00:00.000Z',
  client_region: 'test',
  machine: {},
  manual: false,
});

const tinyCfg = (over = {}) =>
  defaultConfig({ w: 10, h: 10, maxCallsPerGame: 8, maxGameSeconds: 30, ...over });

describe('deadline mode', () => {
  it('discards a slow reply, steps straight and records a timeout', async () => {
    const cfg = tinyCfg({ baseDeadlineMs: 40, minDeadlineMs: 40 });
    const { run, decisions } = await runGame({
      cfg, adapter: mockAdapter('mock', { latencyMs: 5000 }), mode: 'deadline', hints: false, meta: meta('slow'),
    });
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.status).toBe('timeout');
      expect(d.timed_out).toBe(true);
      expect(d.latency_ms).toBeNull();
      expect(d.censored_at_ms).toBe(40);
      expect(d.move).toBeNull();
    }
    expect(run.timeout_rate).toBe(1);
    expect(run.latency_p50_ms).toBeNull();
  });

  it('applies a fast reply to the state it was sent', async () => {
    const cfg = tinyCfg({ baseDeadlineMs: 8000 });
    const { run, decisions, replay } = await runGame({
      cfg, adapter: mockAdapter('mock', { latencyMs: 1 }), mode: 'deadline', hints: false, meta: meta('fast'),
    });
    expect(decisions.every((d) => d.status === 'ok')).toBe(true);
    expect(decisions.every((d) => d.latency_ms !== null)).toBe(true);
    expect(run.timeout_rate).toBe(0);
    expect(run.end_reason).toBe('call_cap');
    expect(replay.end_reason).toBe('call_cap');
    expect(run.censored).toBe(true);
  });
});

describe('turn mode', () => {
  it('measures a slow reply without timing it out', async () => {
    const cfg = tinyCfg({ baseDeadlineMs: 20, maxCallsPerGame: 3 });
    const { run, decisions } = await runGame({
      cfg, adapter: mockAdapter('mock', { latencyMs: 150 }), mode: 'turn', hints: false, meta: meta('turn'),
      turnTimeoutMs: 5000,
    });
    expect(decisions.every((d) => d.status === 'ok')).toBe(true);
    expect(decisions.every((d) => d.deadline_ms === null)).toBe(true);
    expect(run.latency_p50_ms!).toBeGreaterThan(100);
  });
});

describe('pacing and concurrency', () => {
  it('display pacing slows the wall clock but not the measured latency', async () => {
    const cfg = tinyCfg({ maxCallsPerGame: 5 });
    const adapter = () => mockAdapter('mock', { latencyMs: 10 });
    const fast = await runGame({ cfg, adapter: adapter(), mode: 'turn', hints: false, meta: meta('a') });
    const paced = await runGame({
      cfg, adapter: adapter(), mode: 'turn', hints: false, meta: meta('b'), displayMinTickMs: 120,
    });
    expect(paced.run.survival_seconds).toBeGreaterThan(fast.run.survival_seconds + 0.4);
    expect(paced.run.latency_mean_ms!).toBeLessThan(60);
  });

  it('keeps exactly one request in flight and one call per tick, with no retries', async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const inner = greedyAdapter();
    const counting: Adapter = {
      id: 'counting', paid: false, streams: false,
      async decide(ctx) {
        calls++;
        peak = Math.max(peak, ++inFlight);
        await sleep(5, ctx.signal).catch(() => {});
        inFlight--;
        const t = now();
        const { move } = await inner.decide(ctx);
        return { move, timing: { tRequestSent: t, tFirstToken: null, tResponseComplete: now() }, usage: null, raw: String(move) };
      },
    };
    const cfg = tinyCfg({ maxCallsPerGame: 6 });
    const { run, decisions } = await runGame({ cfg, adapter: counting, mode: 'deadline', hints: false, meta: meta('c') });
    expect(peak).toBe(1);
    expect(calls).toBe(decisions.length);
    expect(calls).toBe(run.survival_ticks);
  });
});

describe('budget guard', () => {
  const pricedMock = (): Adapter => ({ ...mockAdapter('expensive', { latencyMs: 5000 }), paid: true });
  const price = { input_per_1m_usd: 10, output_per_1m_usd: 10, source_url: 'test', verified_at: '2026-09-20' };

  it('stops a game mid-way and flags aborted calls as estimated', async () => {
    const cfg = tinyCfg({ baseDeadlineMs: 30, minDeadlineMs: 30, maxCallsPerGame: 100 });
    const { run, decisions } = await runGame({
      cfg, adapter: pricedMock(), mode: 'deadline', hints: false, meta: meta('cap'),
      price, maxTokens: 16, budget: newBudget({ hardCapUsd: 0.004 }),
    });
    expect(run.end_reason).toBe('budget_cap');
    expect(run.censored).toBe(true);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.length).toBeLessThan(100);
    expect(decisions.every((d) => d.cost_estimated)).toBe(true);
    expect(run.cost_usd).toBeGreaterThan(0);
  });

  it('refuses to run a paid model with no verified price', () => {
    const entry = { route: 'openai/not-in-pricing-json', paid: true } as ModelEntry;
    expect(() => requirePrice(entry)).toThrow(/no verified price/);
    expect(requirePrice({ route: 'google/gemini-3.8-flash', paid: true } as ModelEntry)?.input_per_1m_usd).toBe(0.75);
  });
});

/** The failure the scoreboard catches and the per-move metrics miss: an answer that ignores the board. */
const fixedAdapter = (move: Dir): Adapter => ({
  id: `fixed:${move}`,
  paid: false,
  streams: false,
  async decide() {
    const t = now();
    return freeDecision(move, t, move);
  },
});

describe('degeneracy', () => {
  it('flags a model that answers the same move whatever the board says', async () => {
    const cfg = defaultConfig({ seed: 101, maxCallsPerGame: 300 });
    const { run } = await runGame({
      cfg, adapter: fixedAdapter('RIGHT'), mode: 'turn', hints: false, meta: meta('fixed'),
    });
    expect(run.distinct_moves).toBe(1);
    expect(run.move_entropy).toBe(0);
    expect(run.reference_kappa).toBeLessThanOrEqual(0.05);
    expect(run.state_blind).toBe(true);
    // The metric the flag exists to correct: going straight reads as "safe" right up to the wall.
    expect(run.safe_move_rate!).toBeGreaterThan(0.8);
  });

  it('spares a model that plays the board', async () => {
    const cfg = defaultConfig({ seed: 101, maxCallsPerGame: 40 });
    const { run } = await runGame({
      cfg, adapter: greedyAdapter(), mode: 'turn', hints: false, meta: meta('greedy'),
    });
    expect(run.reference_kappa).toBe(1);
    expect(run.reference_agreement).toBe(1);
    expect(run.state_blind).toBe(false);
    expect(run.distinct_moves).toBeGreaterThan(1);
  });
});

describe('baseline-normalized score', () => {
  it('scores the reference policy at 1.0 on its own board', async () => {
    const cfg = defaultConfig({ seed: 101, maxCallsPerGame: 60 });
    const { run } = await runGame({
      cfg, adapter: greedyAdapter(), mode: 'turn', hints: false, meta: meta('norm'),
    });
    expect(run.baseline_score).toBe(run.score);
    expect(run.score_normalized).toBe(1);
  });

  it('puts a model that never eats at 0 against a baseline that does', async () => {
    const cfg = defaultConfig({ seed: 101, maxCallsPerGame: 300 });
    const { run } = await runGame({
      cfg, adapter: fixedAdapter('RIGHT'), mode: 'turn', hints: false, meta: meta('norm-zero'),
    });
    expect(run.baseline_score!).toBeGreaterThan(0);
    expect(run.score).toBe(0);
    expect(run.score_normalized).toBe(0);
  });
});
