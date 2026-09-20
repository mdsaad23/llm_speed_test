'use client';

import { useEffect, useRef, useState } from 'react';
import Board, { PALETTE, useTick } from './board';
import { ARROW, Chart, Feed, Leaderboard, Rail, STATUS } from './panels';
import { deadlineAt, defaultConfig, type Config, type State } from '@/lib/game/engine';
import type { DecisionRecord, RunRecord } from '@/lib/metrics/metrics';
import type { Replay } from '@/lib/runner/run';
import type { UiEvent } from './api/run/route';

interface FreeModel { id: string; note: string | null }

const SEEDS = [101, 102, 103];
const MODES = ['deadline', 'turn', 'freerun'] as const;

type Form = Config & {
  models: string[];
  mode: (typeof MODES)[number];
  hints: boolean;
  tries: number;
  displayMinTickMs: number;
  maxUsdPerRun: number;
};

const DEFAULTS: Form = {
  ...defaultConfig(),
  models: ['mock'],
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
  if (f.models.length === 0) out.push('pick at least one model');
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
  const [available, setAvailable] = useState<FreeModel[]>([]);
  const [view, setView] = useState<'live' | 'replay'>('live');
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [queueLeft, setQueueLeft] = useState(0);
  const [current, setCurrent] = useState(DEFAULTS.models[0]);
  const [warming, setWarming] = useState(false);
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

  useEffect(() => {
    fetch('/api/models').then((r) => r.json()).then(setAvailable).catch(() => setAvailable([]));
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = problems(form);
  const spend = 0; // free models only, priced at zero by definition
  const sessionSpend = runs.reduce((a, r) => a + r.cost_usd, 0);
  const tick = useTick(!!pending);
  const elapsed = pending ? Math.max(0, tick - pending.at) : 0;
  const deadline = pending?.deadline_ms ?? (state ? deadlineAt(state.score, cfg) : null);

  const handle = (e: UiEvent) => {
    if (e.type === 'start') {
      setCurrent(e.model);
      setCfg(e.cfg);
      setState(e.state);
      setDecisions([]);
      setRun(null);
      setLast(null);
      setPending(null);
      setWarming(false);
    } else if (e.type === 'warmup') {
      setWarming(true);
    } else if (e.type === 'pending') {
      setWarming(false);
      setPending({ tick: e.tick, deadline_ms: e.deadline_ms, at: performance.now() });
    } else if (e.type === 'decision') {
      setPending(null);
      setDecisions((d) => [...d, e.decision]);
      setState(e.state);
      setRun(e.run);
      setLast(e.decision);
    } else if (e.type === 'end') {
      setPending(null);
      setWarming(false);
      setRun(e.run);
      setRuns((r) => [...r, e.run]);
    } else {
      setWarming(false);
      setFatal(e.message);
    }
  };

  const runOne = async (model: string, t: number, signal: AbortSignal) => {
    const seed = isOfficial(form, SEEDS[(t - 1) % SEEDS.length]) ? SEEDS[(t - 1) % SEEDS.length] : form.seed;
    const { mode, hints, displayMinTickMs, maxUsdPerRun } = form;
    const cfgBody = { ...defaultConfig(form), seed };
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
    // model × try, one game at a time: a local GPU has no parallelism to give.
    const queue = form.models.flatMap((m) => Array.from({ length: form.tries }, (_, i) => ({ model: m, try: i + 1 })));
    for (const [i, game] of queue.entries()) {
      if (ctrl.signal.aborted) break;
      setTryNo(game.try);
      setQueueLeft(queue.length - i - 1);
      try {
        await runOne(game.model, game.try, ctrl.signal);
      } catch (e) {
        // One model failing is that model's result, not the end of the sweep.
        if (ctrl.signal.aborted) break;
        setFatal(`${game.model}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setRunning(false);
  };

  const status = fatal ? `FAILED: ${fatal}` : running
    ? (warming ? 'LOADING MODEL' : pending ? 'WAITING FOR MOVE' : 'RUNNING')
    : 'IDLE';

  return (
    <main className="mx-auto max-w-[1400px] p-4 text-sm">
      <header className="mb-3 flex flex-wrap items-center gap-3 border-b border-line pb-2">
        <h1 className="text-mustard text-lg">SnakeBench</h1>
        <span className="text-beige">{current}</span>
        <span>level {form.level}</span>
        <span>try {tryNo}/{form.tries}</span>
        <span className="border border-line px-1 uppercase" style={{ color: PALETTE.clay }}>{form.mode}</span>
        <span style={{ color: fatal ? PALETTE.rust : PALETTE.olive }}>● {status}</span>
        <span className="text-beige">queue {queueLeft}</span>
        <span className="text-beige">spent ${sessionSpend.toFixed(5)}</span>
        <button className="ml-auto border border-line px-2 py-0.5" onClick={() => setView(view === 'live' ? 'replay' : 'live')}>
          {view === 'live' ? 'Replays' : 'Live'}
        </button>
      </header>

      {confirming && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-ink/80">
          <div className="w-[520px] border border-line bg-panel p-4">
            <h2 className="mb-2 text-mustard">
              Start {form.models.length * form.tries} game(s)? — {form.models.length} model(s) × {form.tries} tries
            </h2>
            <p>{form.mode} · level {form.level} · {form.w}x{form.h} · up to {form.maxGameSeconds}s per game</p>
            <p className="mt-1 max-h-24 overflow-auto break-all text-beige">{form.models.join(', ')}</p>
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

          <div className="w-72 shrink-0">
            <div className="mb-3 flex gap-2">
              <button
                className="flex-1 border-2 border-line py-3 text-base uppercase tracking-wide disabled:opacity-40"
                style={{ color: PALETTE.olive, borderColor: running || errors.length > 0 ? undefined : PALETTE.olive }}
                disabled={running || errors.length > 0}
                onClick={() => setConfirming(true)}
              >
                ▶ Start
              </button>
              <button
                className="flex-1 border-2 border-line py-3 text-base uppercase tracking-wide disabled:opacity-40"
                style={{ color: PALETTE.rust, borderColor: running ? PALETTE.rust : undefined }}
                disabled={!running}
                onClick={() => abort.current?.abort()}
              >
                ■ Abort
              </button>
            </div>
            <Rail run={run} deadlineMs={deadline} />
          </div>

          <div className="min-w-[420px] flex-1 space-y-4">
            <Feed decisions={decisions} pending={pending} />
            <Leaderboard runs={runs} />
            <PromptPanel form={form} />
            <Manual form={form} set={set} errors={errors} disabled={running} available={available} />
          </div>
        </div>
      )}
    </main>
  );
}

const HELP: Record<string, string> = {
  models:
    'Every free model the server offers. Each checked model plays the whole queue (tries × games) one at a time — a local GPU has no parallelism to give. Paid models stay on the CLI.',
  mode:
    'How the clock treats thinking time. deadline: the board is frozen, but an answer later than the deadline is thrown away and the snake goes straight. turn: frozen and waits forever, so latency never kills you. freerun: the snake keeps moving while the model thinks — demo only, not comparable.',
  w: 'Board width in cells. Official runs are 20x20; changing it marks the run manual.',
  h: 'Board height in cells. Official runs are 20x20; changing it marks the run manual.',
  level: '1 — open board, walls only. 2 — obstacle cells scattered from the seed, always leaving the board fully connected.',
  obstacleCount: 'How many obstacle cells to place. Level 2 only; ignored at level 1.',
  seed: 'Seeds the obstacles and every food placement, so the same seed replays the same board. Official runs use 101, 102, 103 — one per try.',
  tries: 'Games per model. Try 1 gets seed 101, try 2 seed 102, try 3 seed 103, then it wraps.',
  baseDeadlineMs: 'Time budget for the first move, before any food. It shrinks with every point scored.',
  minDeadlineMs: 'Floor for the deadline: no matter how high the score, the model always gets at least this long.',
  paceFactor: 'How much the game tightens per food: deadline = base ÷ factor^score. 1.05 means 5% less time after every point.',
  baseSpeedCps: 'freerun only: cells per second the snake crawls before any food, sped up by the same pace factor.',
  maxGameSeconds: 'Wall-clock cap on one game. Hitting it ends the run with time_limit and marks the result censored.',
  maxCallsPerGame: 'Cap on model calls in one game, so a model that circles forever still terminates.',
  displayMinTickMs: 'Minimum time the board holds each frame so fast models stay watchable. Display only — measured latency is untouched.',
  maxUsdPerRun: 'Budget guard: the run stops as soon as estimated spend passes this. Free models are priced at zero, so it never trips here.',
  hints: 'Adds safe-move flags and food-distance deltas to the state JSON, doing part of the thinking for the model. Hinted runs are excluded from the official summary.',
};

function Help({ k }: { k: keyof typeof HELP }) {
  return (
    <span tabIndex={0} className="group relative cursor-help border border-line px-1 text-beige" aria-label={HELP[k]}>
      ?
      <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 hidden w-64 whitespace-normal border border-line bg-panel p-2 text-cream group-hover:block group-focus:block">
        {HELP[k]}
      </span>
    </span>
  );
}

function Num({ label, help, value, onChange, step = 1 }: {
  label: string;
  help: keyof typeof HELP;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-beige">{label} <Help k={help} /></span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-24 text-right" />
    </label>
  );
}

function Manual({ form, set, errors, disabled, available }: {
  form: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  errors: string[];
  disabled: boolean;
  available: FreeModel[];
}) {
  const toggle = (id: string) =>
    set('models', form.models.includes(id) ? form.models.filter((m) => m !== id) : [...form.models, id]);
  const pick = (test: (id: string) => boolean) => set('models', available.filter((m) => test(m.id)).map((m) => m.id));

  return (
    <details className="border border-line p-2 text-xs" open>
      <summary className="text-mustard">Manual mode</summary>
      <fieldset disabled={disabled} className="mt-2">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-beige">models ({form.models.length}/{available.length}) <Help k="models" /></span>
          <button className="border border-line px-2" onClick={() => pick(() => true)}>all</button>
          <button className="border border-line px-2" onClick={() => pick((id) => id.startsWith('ollama:'))}>ollama</button>
          <button className="border border-line px-2" onClick={() => set('models', [])}>none</button>
        </div>
        <div className="mb-2 max-h-44 overflow-y-auto border border-line p-1">
          {available.length === 0 && <span className="text-beige">no free models</span>}
          {available.map((m) => (
            <label key={m.id} className="flex items-start gap-2 py-0.5">
              <input type="checkbox" className="mt-0.5 shrink-0" checked={form.models.includes(m.id)} onChange={() => toggle(m.id)} />
              <span className="min-w-0 break-all">
                {m.id}
                {m.note && <span className="text-beige"> — {m.note}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled} className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-beige">clock <Help k="mode" /></span>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Form['mode'])} className="w-24">
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <Num label="grid w" help="w" value={form.w} onChange={(v) => set('w', v)} />
        <Num label="grid h" help="h" value={form.h} onChange={(v) => set('h', v)} />
        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-beige">level <Help k="level" /></span>
          <select value={form.level} onChange={(e) => set('level', Number(e.target.value) as Config['level'])} className="w-24">
            <option value={1}>1 — open</option>
            <option value={2}>2 — obstacles</option>
          </select>
        </label>
        <Num label="obstacles" help="obstacleCount" value={form.obstacleCount} onChange={(v) => set('obstacleCount', v)} />
        <Num label="seed" help="seed" value={form.seed} onChange={(v) => set('seed', v)} />
        <Num label="tries" help="tries" value={form.tries} onChange={(v) => set('tries', v)} />
        <Num label="base deadline ms" help="baseDeadlineMs" value={form.baseDeadlineMs} onChange={(v) => set('baseDeadlineMs', v)} step={100} />
        <Num label="min deadline ms" help="minDeadlineMs" value={form.minDeadlineMs} onChange={(v) => set('minDeadlineMs', v)} step={50} />
        <Num label="pace factor" help="paceFactor" value={form.paceFactor} onChange={(v) => set('paceFactor', v)} step={0.01} />
        <Num label="base speed cps" help="baseSpeedCps" value={form.baseSpeedCps} onChange={(v) => set('baseSpeedCps', v)} step={0.5} />
        <Num label="max game seconds" help="maxGameSeconds" value={form.maxGameSeconds} onChange={(v) => set('maxGameSeconds', v)} step={10} />
        <Num label="max calls / game" help="maxCallsPerGame" value={form.maxCallsPerGame} onChange={(v) => set('maxCallsPerGame', v)} step={10} />
        <Num label="display tick ms" help="displayMinTickMs" value={form.displayMinTickMs} onChange={(v) => set('displayMinTickMs', v)} step={10} />
        <Num label="max $ / run" help="maxUsdPerRun" value={form.maxUsdPerRun} onChange={(v) => set('maxUsdPerRun', v)} step={0.1} />
        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-beige">hints <Help k="hints" /></span>
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

interface PromptPreview { system: string; example: string; schema: string; version: string }

/** Built server-side from the configured board, so what is shown here is literally what the adapter sends. */
function PromptPanel({ form }: { form: Form }) {
  const [p, setP] = useState<PromptPreview | null>(null);
  const { mode, hints, w, h, level, obstacleCount, seed, baseDeadlineMs, minDeadlineMs, paceFactor, baseSpeedCps } = form;

  useEffect(() => {
    const q = { mode, hints, w, h, level, obstacleCount, seed, baseDeadlineMs, minDeadlineMs, paceFactor, baseSpeedCps };
    const params = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
    fetch(`/api/prompt?${params}`).then((r) => r.json()).then(setP).catch(() => setP(null));
  }, [mode, hints, w, h, level, obstacleCount, seed, baseDeadlineMs, minDeadlineMs, paceFactor, baseSpeedCps]);

  const block = (title: string, body: string) => (
    <>
      <p className="mt-2 text-beige">{title}</p>
      <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all border border-line p-2">{body}</pre>
    </>
  );

  return (
    <details className="border border-line p-2 text-xs">
      <summary className="text-mustard">Prompt sent to the model {p && <span className="text-beige">· version {p.version}</span>}</summary>
      {p ? (
        <>
          {block('system message — identical on every call, so providers can cache it', p.system)}
          {block('user message — the whole board, resent from scratch each move (shown at tick 0)', p.example)}
          {block('the reply is parsed against this schema; anything else counts as invalid', p.schema)}
        </>
      ) : (
        <p className="mt-2 text-beige">loading…</p>
      )}
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
