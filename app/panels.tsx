'use client';

import { useEffect, useRef, useState } from 'react';
import { PALETTE } from './board';
import type { DecisionRecord, DecisionStatus, RunRecord } from '@/lib/metrics/metrics';

/** Status is always icon + word first, colour second: olive and rust are never the only difference. */
export const STATUS: Record<DecisionStatus, { icon: string; label: string; color: string }> = {
  ok: { icon: '✓', label: 'OK', color: PALETTE.olive },
  timeout: { icon: '⏱', label: 'TIMEOUT', color: PALETTE.rust },
  invalid: { icon: '✕', label: 'INVALID', color: PALETTE.mustard },
  error: { icon: '!', label: 'ERROR', color: PALETTE.clay },
};

export const ARROW: Record<string, string> = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 5 : 2);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line/50 py-0.5">
      <span className="text-beige">{label}</span>
      <span className="tabular-nums">{fmt(value)}</span>
    </div>
  );
}

const GROUPS: Record<string, (keyof RunRecord)[]> = {
  Speed: ['latency_mean_ms', 'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms', 'latency_max_ms',
    'latency_lb_p50_ms', 'latency_lb_p95_ms', 'latency_lb_p99_ms', 'ttft_mean_ms', 'call_ms_mean'],
  'Score & survival': ['score', 'final_length', 'survival_seconds', 'survival_ticks', 'foods_per_min',
    'avg_time_to_food_s', 'avg_ticks_to_food', 'decisions_per_food', 'end_reason', 'censored'],
  Deadline: ['deadline_at_death_ms', 'mean_margin_ms', 'first_timeout_food', 'timeouts_by_food_bracket',
    'predicted_breakpoint_k', 'actual_breakpoint_k'],
  Cost: ['cost_usd', 'cost_per_move_usd', 'cost_per_second_usd', 'score_per_dollar', 'cost_estimated_calls'],
  Tokens: ['tokens_in', 'tokens_out', 'tokens_reasoning', 'tokens_total', 'tokens_per_sec_mean', 'tokens_per_sec_basis'],
  'Decision quality': ['safe_move_rate', 'food_approach_rate', 'path_efficiency', 'confidence_mean'],
  Errors: ['timeout_rate', 'invalid_rate', 'error_rate', 'rejected_reversal'],
  'Run metadata': ['model', 'route', 'reasoning', 'prompt_version', 'hints', 'mode', 'base_deadline_ms',
    'min_deadline_ms', 'pace_factor', 'seed', 'level', 'try', 'grid', 'timestamp', 'client_region', 'manual'],
};

export function Rail({ run, deadlineMs }: { run: RunRecord | null; deadlineMs: number | null }) {
  return (
    <div className="w-72 shrink-0 text-xs">
      <h2 className="mb-1 text-beige uppercase tracking-wide">Metrics</h2>
      <Row label="latency p50" value={run?.latency_p50_ms} />
      <Row label="latency p95" value={run?.latency_p95_ms} />
      <Row label="timeout rate" value={run?.timeout_rate} />
      <Row label="score" value={run?.score ?? 0} />
      <Row label="length" value={run?.final_length ?? 3} />
      <Row label="deadline now" value={deadlineMs === null ? null : Math.round(deadlineMs)} />
      <Row label="cost / move" value={run?.cost_per_move_usd ?? 0} />
      <Row label="cost so far" value={run?.cost_usd ?? 0} />
      <Row label="avg time to food" value={run?.avg_time_to_food_s} />
      <Row label="safe-move rate" value={run?.safe_move_rate} />

      <div className="mt-3">
        {Object.entries(GROUPS).map(([group, keys]) => (
          <details key={group} className="border-b border-line py-1">
            <summary className="text-mustard">{group}</summary>
            {keys.map((k) => (
              <Row key={String(k)} label={String(k)} value={run ? run[k] : null} />
            ))}
          </details>
        ))}
      </div>
    </div>
  );
}

export function Feed({ decisions, pending }: { decisions: DecisionRecord[]; pending: { tick: number } | null }) {
  const rows = decisions.slice(-60).reverse();
  return (
    <div className="text-xs">
      <h2 className="mb-1 text-beige uppercase tracking-wide">Decisions</h2>
      <div className="max-h-72 overflow-auto">
        <table className="w-full tabular-nums">
          <thead className="text-beige">
            <tr>
              <th className="text-left">tick</th>
              <th className="text-left">status</th>
              <th className="text-left">move</th>
              <th className="text-right">latency</th>
              <th className="text-right">deadline</th>
              <th className="text-right">tokens</th>
              <th className="text-right">cost</th>
            </tr>
          </thead>
          <tbody>
            {pending && (
              <tr style={{ color: PALETTE.mustard }}>
                <td>{pending.tick}</td>
                <td>… waiting</td>
                <td colSpan={5} />
              </tr>
            )}
            {rows.map((d) => (
              <tr key={`${d.tick}-${d.status}`} style={{ color: STATUS[d.status].color }}>
                <td>{d.tick}</td>
                <td>{STATUS[d.status].icon} {STATUS[d.status].label}</td>
                <td>{d.move ? `${ARROW[d.move]} ${d.move}` : 'straight'}</td>
                <td className="text-right">{d.latency_ms ?? (d.censored_at_ms ? `>${d.censored_at_ms}` : '—')}</td>
                <td className="text-right">{d.deadline_ms ?? '—'}</td>
                <td className="text-right">{d.tokens_out ?? '—'}</td>
                <td className="text-right">{d.cost_usd ? d.cost_usd.toFixed(6) : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Deadline curve against every measured call: where the two lines cross is where the model starts dying. */
export function Chart({ decisions }: { decisions: DecisionRecord[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = (canvas.width = 560);
    const H = (canvas.height = 180);
    ctx.fillStyle = PALETTE.panel;
    ctx.fillRect(0, 0, W, H);
    if (!decisions.length) return;

    const values = decisions.flatMap((d) => [d.deadline_ms ?? 0, d.latency_ms ?? d.censored_at_ms ?? 0]);
    const maxY = Math.max(...values, 1);
    const x = (i: number) => (i / Math.max(decisions.length - 1, 1)) * (W - 10) + 5;
    const y = (v: number) => H - 5 - (v / maxY) * (H - 20);

    if (decisions[0].deadline_ms !== null) {
      ctx.strokeStyle = PALETTE.beige;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      decisions.forEach((d, i) => (i ? ctx.lineTo(x(i), y(d.deadline_ms ?? 0)) : ctx.moveTo(x(i), y(d.deadline_ms ?? 0))));
      ctx.stroke();
    }

    decisions.forEach((d, i) => {
      if (d.timed_out) {
        // Timeouts get a cross, not just a colour.
        const cy = y(d.censored_at_ms ?? 0);
        ctx.strokeStyle = PALETTE.rust;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x(i) - 4, cy - 4);
        ctx.lineTo(x(i) + 4, cy + 4);
        ctx.moveTo(x(i) + 4, cy - 4);
        ctx.lineTo(x(i) - 4, cy + 4);
        ctx.stroke();
      } else if (d.latency_ms !== null) {
        ctx.fillStyle = PALETTE.olive;
        ctx.beginPath();
        ctx.arc(x(i), y(d.latency_ms), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    const last = decisions.slice(-50).map((d) => d.latency_ms ?? d.censored_at_ms ?? 0);
    const sparkMax = Math.max(...last, 1);
    ctx.strokeStyle = PALETTE.mustard;
    ctx.lineWidth = 1;
    ctx.beginPath();
    last.forEach((v, i) => {
      const sx = W - 110 + (i / Math.max(last.length - 1, 1)) * 100;
      const sy = 30 - (v / sparkMax) * 22;
      return i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
    ctx.stroke();

    ctx.fillStyle = PALETTE.beige;
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`max ${Math.round(maxY)} ms · last 50 →`, 8, 14);
  }, [decisions]);

  return <canvas ref={ref} className="border border-line" aria-label="deadline versus latency" />;
}

type SortKey = 'score' | 'latency_p50_ms' | 'cost_usd' | 'timeout_rate';

export function Leaderboard({ runs }: { runs: RunRecord[] }) {
  const [key, setKey] = useState<SortKey>('score');
  const sorted = [...runs].sort((a, b) => {
    const [x, y] = [a[key] ?? 0, b[key] ?? 0];
    return key === 'score' ? Number(y) - Number(x) : Number(x) - Number(y);
  });
  const head = (k: SortKey, label: string) => (
    <th className={`cursor-pointer text-right ${key === k ? 'text-mustard' : ''}`} onClick={() => setKey(k)}>
      {label}{key === k ? ' ▾' : ''}
    </th>
  );

  return (
    <div className="text-xs">
      <h2 className="mb-1 text-beige uppercase tracking-wide">Leaderboard (this session)</h2>
      <table className="w-full tabular-nums">
        <thead className="text-beige">
          <tr>
            <th className="text-left">model</th>
            <th className="text-left">mode</th>
            <th className="text-right">try</th>
            {head('score', 'score')}
            {head('latency_p50_ms', 'p50 ms')}
            {head('timeout_rate', 'timeouts')}
            {head('cost_usd', 'cost $')}
            <th className="text-left">end</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.run_id}>
              <td>{r.model}</td>
              <td>{r.mode}</td>
              <td className="text-right">{r.try}</td>
              <td className="text-right">{r.score}</td>
              <td className="text-right">{fmt(r.latency_p50_ms)}</td>
              <td className="text-right">{r.timeout_rate.toFixed(2)}</td>
              <td className="text-right">{r.cost_usd.toFixed(5)}</td>
              <td>{r.end_reason}{r.censored ? ' (censored)' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
