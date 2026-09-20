'use client';

import { useEffect, useRef, useState } from 'react';
import Board, { PALETTE, useTick } from './board';
import { ARROW, Chart, Feed, Leaderboard, Rail, STATUS } from './panels';
import { deadlineAt, defaultConfig, type Config, type State } from '@/lib/game/engine';
import type { DecisionRecord, RunRecord } from '@/lib/metrics/metrics';
import type { Replay } from '@/lib/runner/run';
import type { UiEvent } from './api/run/route';

/** Paid models are deliberately absent: the browser can only run what costs nothing. */
const FREE_MODELS = ['mock', 'mock:slow', 'baseline:greedy-bfs', 'baseline:random'];
const SEEDS = [101, 102, 103];
const MODES = ['deadline', 'turn', 'freerun'] as const;

type Form = Config & {
  model: string;
  mode: (typeof MODES)[number];
  hints: boolean;
  tries: number;
  displayMinTickMs: number;
  maxUsdPerRun: number;
};

const DEFAULTS: Form = {
  ...defaultConfig(),
  model: 'mock',
  mode: 'deadline',
  hints: false,
  tries: 3,
  displayMinTickMs: 150,
  maxUsdPerRun: 1,
};

/** A run only counts as official when it matches the benchmark's own settings on the official seeds. */
const isOfficial = (f: Form, seed: number) => {
  const base = defaultConfig();
  const same = (Object.keys(base) as (keyof Config)[]).every((k) => (k === 'seed' ? true : f[k] === base[k]));
  return same && SEEDS.includes(seed) && f.mode !== 'freerun' && !f.hints;
};

function problems(f: Form): string[] {
  const out: string[] = [];
  if (f.w < 5 || f.h < 5) out.push('grid must be at least 5x5');
  if (f.minDeadlineMs > f.baseDeadlineMs) out.push('min deadline cannot exceed base deadline');
  if (f.level === 2 && f.obstacleCount > Math.floor((f.w * f.h) / 6)) out.push('too many obstacles for this grid');
  if (f.level === 2 && f.obstacleCount < 1) out.push('level 2 needs at least one obstacle');
  if (f.paceFactor < 1) out.push('pace factor below 1 would slow the game down as it scores');
  if (f.tries < 1) out.push('at least one try');
  return out;
}

export default function Page() {
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [view, setView] = useState<'live' | 'replay'>('live');
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [queueLeft, setQueueLeft] = useState(0);
  const [tryNo, setTryNo] = useState(1);
  const [cfg, setCfg] = useState<Config>(DEFAULTS);
  const [state, setState] = useState<State | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [pending, setPending] = useState<{ tick: number; deadline_ms: number | null; at: number } | null>(null);
  const [last, setLast] = useState<DecisionRecord | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = problems(form);
  const spend = 0; // free models only, priced at zero by definition
  const sessionSpend = runs.reduce((a, r) => a + r.cost_usd, 0);
  const tick = useTick(!!pending);
  const elapsed = pending ? Math.max(0, tick - pending.at) : 0;
  const deadline = pending?.deadline_ms ?? (state ? deadlineAt(state.score, cfg) : null);

  const handle = (e: UiEvent) => {
    if (e.type === 'start') {
      setCfg(e.cfg);
      setState(e.state);
      setDecisions([]);
      setRun(null);
      setLast(null);
      setPending(null);
    } else if (e.type === 'pending') {
      setPending({ tick: e.tick, deadline_ms: e.deadline_ms, at: performance.now() });
    } else if (e.type === 'decision') {
      setPending(null);
      setDecisions((d) => [...d, e.decision]);
      setState(e.state);
      setRun(e.run);
      setLast(e.decision);
    } else if (e.type === 'end') {
      setPending(null);
      setRun(e.run);
      setRuns((r) => [...r, e.run]);
    } else {
      setFatal(e.message);
    }
  };

  const runOne = async (t: number, signal: AbortSignal) => {
    const seed = isOfficial(form, SEEDS[(t - 1) % SEEDS.length]) ? SEEDS[(t - 1) % SEEDS.length] : form.seed;
    const { model, mode, hints, displayMinTickMs, maxUsdPerRun, ...rest } = form;
    const cfgBody = { ...defaultConfig(rest), seed };
    const res = await fetch('/api/run', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, mode, hints, displayMinTickMs, maxUsdPerRun,
        try: t,
        manual: !isOfficial(form, seed),
        cfg: {
          w: cfgBody.w, h: cfgBody.h, level: cfgBody.level, obstacleCount: cfgBody.obstacleCount, seed,
          baseDeadlineMs: cfgBody.baseDeadlineMs, minDeadlineMs: cfgBody.minDeadlineMs,
          paceFactor: cfgBody.paceFactor, baseSpeedCps: cfgBody.baseSpeedCps,
          maxGameSeconds: cfgBody.maxGameSeconds, maxCallsPerGame: cfgBody.maxCallsPerGame,
        },
      }),
    });
    if (!res.ok || !res.body) {
      setFatal(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const p of parts) if (p.startsWith('data: ')) handle(JSON.parse(p.slice(6)) as UiEvent);
    }
  };

  const start = async () => {
    setConfirming(false);
    setFatal(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    for (let t = 1; t <= form.tries && !ctrl.signal.aborted; t++) {
      setTryNo(t);
      setQueueLeft(form.tries - t);
      try {
        await runOne(t, ctrl.signal);
      } catch (e) {
        if (!ctrl.signal.aborted) setFatal(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    setRunning(false);
  };

  const status = fatal ? `FAILED: ${fatal}` : running ? (pending ? 'WAITING FOR MOVE' : 'RUNNING') : 'IDLE';

  return (
    <main className="mx-auto max-w-[1400px] p-4 text-sm">
      <header className="mb-3 flex flex-wrap items-center gap-3 border-b border-line pb-2">
        <h1 className="text-mustard text-lg">SnakeBench</h1>
        <span className="text-beige">{form.model}</span>
        <span>level {form.level}</span>
        <span>try {tryNo}/{form.tries}</span>
        <span className="border border-line px-1 uppercase" style={{ color: PALETTE.clay }}>{form.mode}</span>
        <span style={{ color: fatal ? PALETTE.rust : PALETTE.olive }}>● {status}</span>
        <span className="text-beige">queue {queueLeft}</span>
        <span className="text-beige">spent ${sessionSpend.toFixed(5)}</span>
        <div className="ml-auto flex gap-2">
          <button className="border border-line px-2 py-0.5" onClick={() => setView(view === 'live' ? 'replay' : 'live')}>
            {view === 'live' ? 'Replays' : 'Live'}
          </button>
          <button
            className="border border-line px-2 py-0.5 disabled:opacity-40"
            style={{ color: PALETTE.olive }}
            disabled={running || errors.length > 0}
            onClick={() => setConfirming(true)}
          >
            Start
          </button>
          <button
            className="border border-line px-2 py-0.5 disabled:opacity-40"
            style={{ color: PALETTE.rust }}
            disabled={!running}
            onClick={() => abort.current?.abort()}
          >
            Abort
          </button>
        </div>
      </header>

      {confirming && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-ink/80">
          <div className="w-[520px] border border-line bg-panel p-4">
            <h2 className="mb-2 text-mustard">Start {form.tries} game(s)?</h2>
            <p>{form.model} · {form.mode} · level {form.level} · {form.w}x{form.h}</p>
            <p className="mt-2">
              Worst case spend: <span className="text-mustard">${spend.toFixed(4)}</span> — free model, no API calls are billed.
            </p>
            <p className="mt-1 text-beige">
              {isOfficial(form, SEEDS[0]) ? 'Official settings: counts towards summary.csv.' : 'Manual settings: excluded from summary.csv.'}
            </p>
            <div className="mt-3 flex gap-2">
              <button className="border border-line px-2 py-0.5" style={{ color: PALETTE.olive }} onClick={start}>Confirm</button>
              <button className="border border-line px-2 py-0.5" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {view === 'replay' ? (
        <ReplayViewer />
      ) : (
        <div className="flex flex-wrap gap-4">
          <div>
            {form.mode === 'freerun' && (
              <p className="mb-2 border border-line px-2 py-1" style={{ color: PALETTE.mustard }}>
                ▲ FREERUN — demo only, moves land late on purpose. Not comparable with deadline or turn results.
              </p>
            )}
            {state ? (
              <Board w={cfg.w} h={cfg.h} snake={state.snake} food={state.food} obstacles={state.obstacles} waiting={!!pending} />
            ) : (
              <div className="flex h-[560px] w-[560px] items-center justify-center border border-line text-beige">
                press Start
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span>score {state?.score ?? 0}</span>
              <span>length {state?.snake.length ?? 3}</span>
              <span>pace x{(form.paceFactor ** (state?.score ?? 0)).toFixed(2)}</span>
              <span>deadline {deadline === null ? '—' : `${Math.round(deadline)} ms`}</span>
              {pending && <span style={{ color: PALETTE.mustard }}>⏳ {Math.round(elapsed)} ms</span>}
            </div>
            {form.mode === 'deadline' && (
              <div className="mt-1 h-2 w-[560px] border border-line">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.max(0, 100 - (deadline ? (elapsed / deadline) * 100 : 0))}%`,
                    background: deadline && elapsed / deadline > 0.75 ? PALETTE.rust : PALETTE.olive,
                  }}
                />
              </div>
            )}
            <div className="mt-2 h-6">
              {last?.status === 'timeout' && (
                <span style={{ color: PALETTE.rust }}>⏱ TIMEOUT: going straight, late answer discarded</span>
              )}
              {last?.status === 'ok' && last.move && (
                <span style={{ color: PALETTE.olive }}>
                  {form.mode === 'freerun' && (last.staleness_ticks ?? 0) > 0 ? '👻 ' : ''}
                  {ARROW[last.move]} {last.move} · {last.latency_ms} ms
                  {form.mode === 'freerun' && last.staleness_ticks !== null && (
                    <span className="ml-2 border border-line px-1" style={{ color: PALETTE.mustard }}>
                      stale {last.staleness_ticks} ticks
                    </span>
                  )}
                </span>
              )}
              {last && (last.status === 'invalid' || last.status === 'error') && (
                <span style={{ color: STATUS[last.status].color }}>
                  {STATUS[last.status].icon} {STATUS[last.status].label}: going straight{last.error ? ` — ${last.error}` : ''}
                </span>
              )}
            </div>
            <div className="mt-3">
              <Chart decisions={decisions} />
            </div>
          </div>

          <Rail run={run} deadlineMs={deadline} />

          <div className="min-w-[420px] flex-1 space-y-4">
            <Feed decisions={decisions} pending={pending} />
            <Leaderboard runs={runs} />
            <Manual form={form} set={set} errors={errors} disabled={running} />
          </div>
        </div>
      )}
    </main>
  );
}

function Num({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-beige">{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-28 text-right" />
    </label>
  );
}

function Manual({ form, set, errors, disabled }: {
  form: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  errors: string[];
  disabled: boolean;
}) {
  return (
    <details className="border border-line p-2 text-xs" open>
      <summary className="text-mustard">Manual mode</summary>
      <fieldset disabled={disabled} className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
        <label className="flex items-center justify-between gap-2">
          <span className="text-beige">model</span>
          <select value={form.model} onChange={(e) => set('model', e.target.value)} className="w-28">
            {FREE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-beige">clock</span>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Form['mode'])} className="w-28">
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <Num label="grid w" value={form.w} onChange={(v) => set('w', v)} />
        <Num label="grid h" value={form.h} onChange={(v) => set('h', v)} />
        <label className="flex items-center justify-between gap-2">
          <span className="text-beige">level</span>
          <select value={form.level} onChange={(e) => set('level', Number(e.target.value) as Config['level'])} className="w-28">
            <option value={1}>1 — open</option>
            <option value={2}>2 — obstacles</option>
          </select>
        </label>
        <Num label="obstacles" value={form.obstacleCount} onChange={(v) => set('obstacleCount', v)} />
        <Num label="seed" value={form.seed} onChange={(v) => set('seed', v)} />
        <Num label="tries" value={form.tries} onChange={(v) => set('tries', v)} />
        <Num label="base deadline ms" value={form.baseDeadlineMs} onChange={(v) => set('baseDeadlineMs', v)} step={100} />
        <Num label="min deadline ms" value={form.minDeadlineMs} onChange={(v) => set('minDeadlineMs', v)} step={50} />
        <Num label="pace factor" value={form.paceFactor} onChange={(v) => set('paceFactor', v)} step={0.01} />
        <Num label="base speed cps" value={form.baseSpeedCps} onChange={(v) => set('baseSpeedCps', v)} step={0.5} />
        <Num label="max game seconds" value={form.maxGameSeconds} onChange={(v) => set('maxGameSeconds', v)} step={10} />
        <Num label="max calls / game" value={form.maxCallsPerGame} onChange={(v) => set('maxCallsPerGame', v)} step={10} />
        <Num label="display tick ms" value={form.displayMinTickMs} onChange={(v) => set('displayMinTickMs', v)} step={10} />
        <Num label="max $ / run" value={form.maxUsdPerRun} onChange={(v) => set('maxUsdPerRun', v)} step={0.1} />
        <label className="flex items-center justify-between gap-2">
          <span className="text-beige">hints</span>
          <input type="checkbox" checked={form.hints} onChange={(e) => set('hints', e.target.checked)} />
        </label>
      </fieldset>
      <div className="mt-2 flex gap-2">
        <button className="border border-line px-2 py-0.5" disabled={disabled} onClick={() => {
          for (const [k, v] of Object.entries(DEFAULTS)) set(k as keyof Form, v as never);
        }}>Reset to official</button>
        <button className="border border-line px-2 py-0.5" disabled={disabled} onClick={() => {
          set('w', 10); set('h', 10); set('baseDeadlineMs', 2000); set('maxCallsPerGame', 60); set('tries', 1);
        }}>Preset: quick 10x10</button>
      </div>
      {errors.length > 0 && (
        <ul className="mt-2" style={{ color: PALETTE.rust }}>
          {errors.map((e) => <li key={e}>✕ {e}</li>)}
        </ul>
      )}
      <p className="mt-2 text-beige">
        Worst-case spend for this configuration: $0.0000 — the browser can only run free models. Reasoning and max_tokens
        live in models.config.ts, where paid runs read them.
      </p>
    </details>
  );
}

function ReplayViewer() {
  const [list, setList] = useState<{ id: string }[]>([]);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [i, setI] = useState(0);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    fetch('/api/replays').then((r) => r.json()).then(setList).catch(() => setList([]));
  }, []);

  useEffect(() => {
    if (!speed || !replay) return;
    const id = setInterval(() => setI((v) => Math.min(v + 1, replay.frames.length - 1)), 200 / speed);
    return () => clearInterval(id);
  }, [speed, replay]);

  const frame = replay?.frames[i];
  return (
    <div className="flex flex-wrap gap-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <select
            className="w-[320px]"
            onChange={async (e) => {
              const r = await fetch(`/api/replays?id=${e.target.value}`).then((x) => x.json());
              setReplay(r);
              setI(0);
              setSpeed(0);
            }}
            defaultValue=""
          >
            <option value="" disabled>pick a replay ({list.length} saved)</option>
            {list.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
          </select>
          {[1, 2, 4].map((s) => (
            <button key={s} className="border border-line px-2" style={{ color: speed === s ? PALETTE.mustard : undefined }}
              onClick={() => setSpeed(speed === s ? 0 : s)}>
              {speed === s ? '❚❚' : '▶'} {s}x
            </button>
          ))}
          <span className="text-beige">no API calls</span>
        </div>
        {replay && frame ? (
          <>
            <Board w={replay.config.w} h={replay.config.h} snake={frame.snake} food={frame.food}
              obstacles={replay.obstacles} waiting={false} />
            <input type="range" min={0} max={replay.frames.length - 1} value={i}
              onChange={(e) => setI(Number(e.target.value))} className="mt-2 w-[560px]" />
            <div className="mt-1 flex gap-3">
              <span>tick {frame.tick}</span>
              <span>score {frame.score}</span>
              <span>{STATUS[frame.status].icon} {STATUS[frame.status].label}</span>
              <span>{frame.latency_ms ?? '—'} ms</span>
              <span className="text-beige">{replay.meta.model} · {replay.meta.mode} · seed {replay.meta.seed}</span>
            </div>
          </>
        ) : (
          <div className="flex h-[560px] w-[560px] items-center justify-center border border-line text-beige">
            pick a replay
          </div>
        )}
      </div>
      {replay && (
        <div className="min-w-[420px] flex-1 space-y-4">
          <Chart decisions={replay.decisions} />
          <Feed decisions={replay.decisions.slice(0, i + 1)} pending={null} />
        </div>
      )}
    </div>
  );
}
