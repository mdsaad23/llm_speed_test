import type { EndReason } from '@/lib/game/engine';

export type DecisionStatus = 'ok' | 'timeout' | 'invalid' | 'error';

export interface DecisionRecord {
  run_id: string;
  tick: number;
  score: number;
  deadline_ms: number | null;
  move: string | null;
  /** What the greedy-BFS reference policy would have played on this same board. */
  reference_move: string | null;
  latency_ms: number | null;
  timed_out: boolean;
  censored_at_ms: number | null;
  status: DecisionStatus;
  ttft_ms: number | null;
  call_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_reasoning: number | null;
  tokens_total: number | null;
  tokens_per_sec: number | null;
  tokens_per_sec_basis: 'first_token' | 'call_duration' | null;
  cost_usd: number;
  cost_estimated: boolean;
  gateway_cost_usd: number | null;
  safe: boolean | null;
  food_delta: number | null;
  staleness_ticks: number | null;
  confidence: number | null;
  error: string | null;
  raw: string;
}

export interface RunMeta {
  run_id: string;
  model: string;
  route: string;
  reasoning: string;
  reasoning_requested: string;
  prompt_version: string;
  hints: boolean;
  mode: string;
  base_deadline_ms: number;
  min_deadline_ms: number;
  pace_factor: number;
  seed: number;
  level: number;
  try: number;
  grid: string;
  timestamp: string;
  client_region: string;
  machine: Record<string, string>;
  manual: boolean;
  manual_params?: Record<string, unknown>;
}

export interface RunRecord extends RunMeta {
  score: number;
  final_length: number;
  survival_seconds: number;
  survival_ticks: number;
  foods_per_min: number;
  end_reason: EndReason | null;
  censored: boolean;

  calls: number;
  latency_mean_ms: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  latency_max_ms: number | null;
  latency_lb_p50_ms: number | null;
  latency_lb_p95_ms: number | null;
  latency_lb_p99_ms: number | null;
  ttft_mean_ms: number | null;
  call_ms_mean: number | null;
  tokens_per_sec_mean: number | null;
  tokens_per_sec_basis: string | null;

  timeout_rate: number;
  invalid_rate: number;
  error_rate: number;
  rejected_reversal: number;

  baseline_score: number | null;
  score_normalized: number | null;

  distinct_moves: number;
  move_entropy: number | null;
  reference_agreement: number | null;
  reference_kappa: number | null;
  state_blind: boolean;

  deadline_at_death_ms: number | null;
  first_timeout_food: number | null;
  timeouts_by_food_bracket: Record<string, number>;
  mean_margin_ms: number | null;
  predicted_breakpoint_k: number | null;
  actual_breakpoint_k: number | null;

  cost_usd: number;
  cost_per_move_usd: number;
  cost_per_second_usd: number;
  score_per_dollar: number | null;
  cost_estimated_calls: number;

  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  tokens_total: number;

  avg_time_to_food_s: number | null;
  avg_ticks_to_food: number | null;
  decisions_per_food: number | null;
  safe_move_rate: number | null;
  food_approach_rate: number | null;
  path_efficiency: number | null;
  confidence_mean: number | null;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
export const median = (v: number[]) => percentile(v, 50);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
/** Keeps a null out of a mean instead of letting `?? 0` drag it down. */
const isNumber = (v: number | null): v is number => v !== null && Number.isFinite(v);

export interface Price {
  input_per_1m_usd: number;
  output_per_1m_usd: number;
  source_url: string;
  verified_at: string;
}

export const callCost = (
  price: Price | null,
  tokensIn: number | null,
  tokensOut: number | null,
): number =>
  price ? ((tokensIn ?? 0) * price.input_per_1m_usd + (tokensOut ?? 0) * price.output_per_1m_usd) / 1e6 : 0;

/** First food count k at which the shrinking deadline drops below a reference latency. */
export function deadlineBreakpoint(
  cfg: { baseDeadlineMs: number; minDeadlineMs: number; paceFactor: number },
  referenceMs: number,
): number | null {
  for (let k = 0; k <= 500; k++) {
    if (Math.max(cfg.minDeadlineMs, cfg.baseDeadlineMs / cfg.paceFactor ** k) < referenceMs) return k;
  }
  return null;
}

/** A move is only evidence about the board when a reference move exists to compare it against. */
type MovePair = { move: string; reference: string };

/**
 * Shannon entropy of the emitted moves, normalised by log(4). Four, not the three offered on any
 * one turn: which three those are depends on the heading, and the heading turns, so a game that
 * plays the board uses all four compass moves. 0 is one move from start to finish.
 */
export function moveEntropy(moves: string[]): number | null {
  if (!moves.length) return null;
  const counts = new Map<string, number>();
  for (const m of moves) counts.set(m, (counts.get(m) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / moves.length;
    h -= p * Math.log(p);
  }
  return h / Math.log(4);
}

const share = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return new Map([...counts].map(([v, n]) => [v, n / values.length]));
};

/**
 * How well the moves track the reference policy, raw and chance-corrected (Cohen's kappa).
 *
 * The correction is the point. Raw agreement flatters a model that answers the same literal move
 * every turn — it collects every board where that move happened to be right and reads as skill.
 * Kappa subtracts what the two marginals would agree on by coincidence, so a fixed answer scores
 * ~0 however lucky it is, and only a move that moves *with* the board scores above it.
 *
 * `kappa` is null when chance already explains everything (both sides constant and equal): there
 * is no room left to measure.
 */
export function referenceAgreement(pairs: MovePair[]): { observed: number | null; kappa: number | null } {
  if (!pairs.length) return { observed: null, kappa: null };
  const observed = pairs.filter((p) => p.move === p.reference).length / pairs.length;
  const model = share(pairs.map((p) => p.move));
  const reference = share(pairs.map((p) => p.reference));
  let expected = 0;
  for (const [m, p] of model) expected += p * (reference.get(m) ?? 0);
  return { observed, kappa: expected >= 1 ? null : (observed - expected) / (1 - expected) };
}

/**
 * Below this there is not enough play to tell a blind model from an unlucky one. Kept low on
 * purpose: a model that answers one fixed move walks into the nearest wall in about ten moves on
 * the official 20x20, so a higher bar would never fire on exactly the models this is for. The
 * price is noise on a single run, which is what `state_blind_runs` in the summary is for — one
 * flagged try is a look, three of three is the finding.
 */
const BLIND_MIN_DECISIONS = 8;
/** Kappa this close to zero means the moves carry no more board information than chance. */
const BLIND_MAX_KAPPA = 0.05;

/**
 * Screening flag, not a verdict: the moves carry no more information about the board than chance
 * would give. It catches the model that answers one literal move all game and the one that picks
 * at random alike, because operationally neither is reading anything.
 *
 * Two shapes, because a short game often never varies the right answer — a snake that dies in ten
 * moves without eating leaves the food where it was, so the reference points the same way
 * throughout:
 *
 * - the reference varied, so covariation is measurable and kappa decides on its own;
 * - the reference never varied, so kappa is 0 for anything that is not a perfect match and cannot
 *   separate a blind model from a bad one. Only a model that is itself stuck on a single move is
 *   flagged — stuck on the *wrong* one, since matching the reference throughout leaves no kappa
 *   at all. A model whose moves vary against a fixed right answer is playing badly, which is not
 *   the same finding, and is left alone.
 *
 * Read it next to `move_entropy`: 0 is a stuck answer, high is a model reading a board it
 * disagrees with. A model that plays for survival over greed will sit low on kappa without being
 * blind, which is why this flags a run for a look rather than settling it.
 */
export function stateBlind(pairs: MovePair[], kappa: number | null): boolean {
  if (pairs.length < BLIND_MIN_DECISIONS || kappa === null || kappa > BLIND_MAX_KAPPA) return false;
  const referenceVaried = new Set(pairs.map((p) => p.reference)).size >= 2;
  return referenceVaried || new Set(pairs.map((p) => p.move)).size === 1;
}

const CENSORED_ENDINGS: EndReason[] = ['time_limit', 'call_cap', 'budget_cap', 'aborted'];

export function summarizeRun(
  meta: RunMeta,
  decisions: DecisionRecord[],
  game: {
    score: number;
    finalLength: number;
    survivalSeconds: number;
    survivalTicks: number;
    endReason: EndReason | null;
    rejectedReversal: number;
    deadlineAtDeathMs: number | null;
    foodPathLengths: number[];
    foodTickCosts: number[];
    foodSecondCosts: number[];
    predictedBreakpointK: number | null;
    baselineScore: number | null;
  },
): RunRecord {
  const latencies = decisions.filter((d) => d.status === 'ok' && d.latency_ms !== null).map((d) => d.latency_ms!);
  const lowerBound = decisions
    .filter((d) => d.status === 'ok' || d.timed_out)
    .map((d) => (d.timed_out ? (d.censored_at_ms ?? 0) : d.latency_ms!));
  const margins = decisions
    .filter((d) => d.status === 'ok' && d.latency_ms !== null && d.deadline_ms !== null)
    .map((d) => d.deadline_ms! - d.latency_ms!);
  const tps = decisions.filter((d) => d.tokens_per_sec !== null).map((d) => d.tokens_per_sec!);
  const safeFlags = decisions.filter((d) => d.safe !== null).map((d) => (d.safe ? 1 : 0));
  const approach = decisions.filter((d) => d.food_delta !== null).map((d) => (d.food_delta! < 0 ? 1 : 0));
  const confidences = decisions.filter((d) => d.confidence !== null).map((d) => d.confidence!);
  const moves = decisions.filter((d) => d.move !== null).map((d) => d.move!);
  const pairs: MovePair[] = decisions
    .filter((d) => d.move !== null && d.reference_move !== null)
    .map((d) => ({ move: d.move!, reference: d.reference_move! }));
  const agreement = referenceAgreement(pairs);

  const calls = decisions.length;
  const rate = (n: number) => (calls ? n / calls : 0);
  const cost = sum(decisions.map((d) => d.cost_usd));
  const timeouts = decisions.filter((d) => d.timed_out);

  const brackets: Record<string, number> = {};
  for (const d of timeouts) {
    const key = `${Math.floor(d.score / 10) * 10}-${Math.floor(d.score / 10) * 10 + 9}`;
    brackets[key] = (brackets[key] ?? 0) + 1;
  }

  const pathSteps = sum(game.foodTickCosts);
  const shortest = sum(game.foodPathLengths);

  return {
    ...meta,
    score: game.score,
    final_length: game.finalLength,
    survival_seconds: round(game.survivalSeconds, 3)!,
    survival_ticks: game.survivalTicks,
    foods_per_min: game.survivalSeconds > 0 ? round((game.score * 60) / game.survivalSeconds, 3)! : 0,
    end_reason: game.endReason,
    censored: game.endReason !== null && CENSORED_ENDINGS.includes(game.endReason),

    calls,
    latency_mean_ms: round(mean(latencies), 2),
    latency_p50_ms: round(percentile(latencies, 50), 2),
    latency_p95_ms: round(percentile(latencies, 95), 2),
    latency_p99_ms: round(percentile(latencies, 99), 2),
    latency_max_ms: latencies.length ? round(Math.max(...latencies), 2) : null,
    latency_lb_p50_ms: round(percentile(lowerBound, 50), 2),
    latency_lb_p95_ms: round(percentile(lowerBound, 95), 2),
    latency_lb_p99_ms: round(percentile(lowerBound, 99), 2),
    ttft_mean_ms: round(mean(decisions.filter((d) => d.ttft_ms !== null).map((d) => d.ttft_ms!)), 2),
    call_ms_mean: round(mean(decisions.filter((d) => d.call_ms !== null).map((d) => d.call_ms!)), 2),
    tokens_per_sec_mean: round(mean(tps), 2),
    tokens_per_sec_basis: decisions.find((d) => d.tokens_per_sec_basis)?.tokens_per_sec_basis ?? null,

    timeout_rate: round(rate(timeouts.length), 4)!,
    invalid_rate: round(rate(decisions.filter((d) => d.status === 'invalid').length), 4)!,
    error_rate: round(rate(decisions.filter((d) => d.status === 'error').length), 4)!,
    rejected_reversal: game.rejectedReversal,

    baseline_score: game.baselineScore,
    score_normalized:
      game.baselineScore !== null && game.baselineScore > 0 ? round(game.score / game.baselineScore, 3) : null,

    distinct_moves: new Set(moves).size,
    move_entropy: round(moveEntropy(moves), 4),
    reference_agreement: round(agreement.observed, 4),
    reference_kappa: round(agreement.kappa, 4),
    state_blind: stateBlind(pairs, agreement.kappa),

    deadline_at_death_ms: round(game.deadlineAtDeathMs, 2),
    first_timeout_food: timeouts.length ? timeouts[0].score : null,
    timeouts_by_food_bracket: brackets,
    mean_margin_ms: round(mean(margins), 2),
    predicted_breakpoint_k: game.predictedBreakpointK,
    actual_breakpoint_k: timeouts.length ? timeouts[0].score : null,

    cost_usd: round(cost, 8)!,
    cost_per_move_usd: calls ? round(cost / calls, 10)! : 0,
    cost_per_second_usd: game.survivalSeconds > 0 ? round(cost / game.survivalSeconds, 10)! : 0,
    score_per_dollar: cost > 0 ? round(game.score / cost, 2) : null,
    cost_estimated_calls: decisions.filter((d) => d.cost_estimated).length,

    tokens_in: sum(decisions.map((d) => d.tokens_in ?? 0)),
    tokens_out: sum(decisions.map((d) => d.tokens_out ?? 0)),
    tokens_reasoning: sum(decisions.map((d) => d.tokens_reasoning ?? 0)),
    tokens_total: sum(decisions.map((d) => d.tokens_total ?? 0)),

    avg_time_to_food_s: round(mean(game.foodSecondCosts), 3),
    avg_ticks_to_food: round(mean(game.foodTickCosts), 2),
    decisions_per_food: game.score > 0 ? round(calls / game.score, 2) : null,
    safe_move_rate: round(mean(safeFlags), 4),
    food_approach_rate: round(mean(approach), 4),
    path_efficiency: shortest > 0 ? round(pathSteps / shortest, 3) : null,
    confidence_mean: round(mean(confidences), 4),
  };
}

function round(v: number | null, places: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

const SUMMARY_COLUMNS = [
  'model', 'level', 'mode', 'tries',
  'best_score', 'mean_score', 'median_score', 'all_scores',
  'mean_baseline_score', 'mean_score_normalized',
  'move_entropy', 'reference_agreement', 'reference_kappa', 'state_blind_runs',
  'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms', 'timeout_rate',
  'cost_per_move_usd', 'cost_per_second_usd', 'cost_usd',
  'avg_time_to_food_s', 'safe_move_rate', 'path_efficiency',
  'censored_runs', 'end_reasons',
] as const;

/** One row per model x level x mode. freerun and manual runs are filtered by the caller. */
export function summaryCsv(runs: RunRecord[]): string {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.model} ${r.level} ${r.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rows = [...groups.values()].map((g) => {
    const scores = g.map((r) => r.score);
    const cell = (k: (typeof SUMMARY_COLUMNS)[number]) => {
      switch (k) {
        case 'model': return g[0].model;
        case 'level': return g[0].level;
        case 'mode': return g[0].mode;
        case 'tries': return g.length;
        case 'best_score': return Math.max(...scores);
        case 'mean_score': return round(mean(scores), 3);
        case 'median_score': return median(scores);
        case 'all_scores': return scores.join(' ');
        case 'mean_baseline_score': return round(mean(g.map((r) => r.baseline_score).filter(isNumber)), 3);
        case 'mean_score_normalized': return round(mean(g.map((r) => r.score_normalized).filter(isNumber)), 3);
        case 'move_entropy': return round(mean(g.map((r) => r.move_entropy).filter(isNumber)), 4);
        case 'reference_agreement': return round(mean(g.map((r) => r.reference_agreement).filter(isNumber)), 4);
        case 'reference_kappa': return round(mean(g.map((r) => r.reference_kappa).filter(isNumber)), 4);
        case 'state_blind_runs': return g.filter((r) => r.state_blind).length;
        case 'censored_runs': return g.filter((r) => r.censored).length;
        case 'end_reasons': return [...new Set(g.map((r) => r.end_reason))].join(' ');
        default: return round(mean(g.map((r) => (r[k] as number | null) ?? 0).filter(Number.isFinite)), 6);
      }
    };
    return SUMMARY_COLUMNS.map((k) => csvCell(cell(k))).join(',');
  });
  const penalty = latencyPenaltyRows(runs);
  return [SUMMARY_COLUMNS.join(','), ...rows, '', 'latency_penalty_table', 'model,level,turn_p50_ms,deadline_p50_ms,penalty_ms', ...penalty].join('\n') + '\n';
}

/** turn-mode p50 minus deadline-mode p50: what enforcing the clock costs in measured latency. */
function latencyPenaltyRows(runs: RunRecord[]): string[] {
  const keys = new Set(runs.map((r) => `${r.model} ${r.level}`));
  const out: string[] = [];
  for (const key of keys) {
    const [model, level] = key.split(' ');
    const at = (mode: string) =>
      mean(runs.filter((r) => r.model === model && String(r.level) === level && r.mode === mode && r.latency_p50_ms !== null).map((r) => r.latency_p50_ms!));
    const turn = at('turn');
    const deadline = at('deadline');
    if (turn === null || deadline === null) continue;
    out.push([model, level, round(turn, 2), round(deadline, 2), round(turn - deadline, 2)].map(csvCell).join(','));
  }
  return out;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
