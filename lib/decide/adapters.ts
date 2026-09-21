import { DIRS, opposite, safeMoves, type Config, type Dir, type State } from '@/lib/game/engine';
import { greedyMove } from '@/lib/game/policy';
import type { ClockMode } from '@/lib/decide/prompt';

export interface DecideContext {
  state: State;
  cfg: Config;
  mode: ClockMode;
  hints: boolean;
  signal: AbortSignal;
}

/** Monotonic marks from performance.now(), taken as tightly around the call as possible. */
export interface Timing {
  tRequestSent: number;
  tFirstToken: number | null;
  tResponseComplete: number | null;
}

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  total: number;
  /** true when the numbers are a worst-case reconstruction of an aborted call. */
  estimated: boolean;
}

export interface Decision {
  move: Dir | null;
  timing: Timing;
  usage: Usage | null;
  raw: string;
  confidence?: number | null;
  gatewayCostUsd?: number | null;
}

export interface Adapter {
  id: string;
  paid: boolean;
  /** Tokens/sec is reported against t_first_token only when the adapter streams. */
  streams: boolean;
  decide(ctx: DecideContext): Promise<Decision>;
  warmup?(cfg: Config): Promise<void>;
  /** Hand the weights back when the run is over, so the next model is not measured through a full GPU. */
  unload?(): Promise<void>;
}

export const now = () => performance.now();

export const freeDecision = (move: Dir | null, t: number, raw: string): Decision => ({
  move,
  timing: { tRequestSent: t, tFirstToken: t, tResponseComplete: now() },
  usage: null,
  raw,
});

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomAdapter = (seed = 1): Adapter => {
  const rng = mulberry(seed);
  return {
    id: 'baseline:random',
    paid: false,
    streams: false,
    async decide({ state, cfg }) {
      const t = now();
      const safe = safeMoves(state, cfg);
      const pool = safe.length ? safe : DIRS.filter((d) => d !== opposite(state.dir));
      const move = pool[Math.floor(rng() * pool.length)];
      return freeDecision(move, t, move);
    },
  };
};

export const greedyAdapter = (): Adapter => ({
  id: 'baseline:greedy-bfs',
  paid: false,
  streams: false,
  async decide({ state, cfg }) {
    const t = now();
    const move = greedyMove(state, cfg);
    return freeDecision(move, t, move ?? 'trapped');
  },
});

export interface MockOptions {
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  invalidRate: number;
  seed: number;
}

export const defaultMockOptions: MockOptions = {
  latencyMs: 120, jitterMs: 0, errorRate: 0, invalidRate: 0, seed: 7,
};

/** Stands in for a paid model in the UI and in every test. Costs nothing, honours the signal. */
export const mockAdapter = (id: string, opts: Partial<MockOptions> = {}): Adapter => {
  const o = { ...defaultMockOptions, ...opts };
  const rng = mulberry(o.seed);
  const inner = greedyAdapter();
  return {
    id,
    paid: false,
    streams: false,
    async decide(ctx) {
      const t = now();
      const wait = o.latencyMs + (o.jitterMs ? rng() * o.jitterMs : 0);
      await sleep(wait, ctx.signal);
      if (rng() < o.errorRate) throw new Error('mock provider error 503');
      const usage: Usage = { input: 180, output: 6, reasoning: 0, total: 186, estimated: false };
      if (rng() < o.invalidRate) {
        return { move: null, timing: { tRequestSent: t, tFirstToken: null, tResponseComplete: now() }, usage, raw: 'sure thing!' };
      }
      const { move } = await inner.decide(ctx);
      return { move, timing: { tRequestSent: t, tFirstToken: null, tResponseComplete: now() }, usage, raw: String(move) };
    },
  };
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
