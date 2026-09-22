import type { RunRecord } from '@/lib/metrics/metrics';

/**
 * Best official run per model, kept in Upstash Redis (Vercel Marketplace), whose integration
 * sets these two variables. Unset (a local checkout): the leaderboard is simply off.
 */
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const BOARDS = {
  score: { direction: 'max', value: (r: RunRecord) => r.score },
  latency: { direction: 'min', value: (r: RunRecord) => r.latency_mean_ms },
} as const;
export type Board = keyof typeof BOARDS;
export type Entry = { mode: string; run: RunRecord };

/** Compare-and-set in one script, so two tries of the same model finishing together cannot trade places. */
const KEEP_BEST = `
local best = tonumber(redis.call('HGET', KEYS[1], ARGV[1]))
local v = tonumber(ARGV[2])
if best and ((ARGV[3] == 'max' and v <= best) or (ARGV[3] == 'min' and v >= best)) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[4])
return 1`;

async function pipeline(commands: (string | number)[][]): Promise<unknown[]> {
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(commands),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`leaderboard store ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { result?: unknown; error?: string }[];
  const failed = out.find((r) => r.error);
  if (failed) throw new Error(`leaderboard store: ${failed.error}`);
  return out.map((r) => r.result);
}

/** Stores the run on each board it beats (or is first on). Ties do not displace the holder. */
export async function recordBest(run: RunRecord): Promise<void> {
  if (!KV_URL || !KV_TOKEN) return;
  const commands = Object.entries(BOARDS)
    .filter(([, b]) => b.value(run) !== null)
    .map(([name, b]) => {
      const key = `best:${name}:${run.mode}`;
      return ['EVAL', KEEP_BEST, 2, key, `${key}:run`, run.model, b.value(run)!, b.direction, JSON.stringify(run)];
    });
  if (commands.length > 0) await pipeline(commands);
}

const MODES = ['deadline', 'turn'];

export async function readLeaderboard(): Promise<Record<Board, Entry[]>> {
  const out: Record<Board, Entry[]> = { score: [], latency: [] };
  if (!KV_URL || !KV_TOKEN) return out;
  const slots = (Object.keys(BOARDS) as Board[]).flatMap((board) => MODES.map((mode) => ({ board, mode })));
  const results = await pipeline(slots.map(({ board, mode }) => ['HGETALL', `best:${board}:${mode}:run`]));
  slots.forEach(({ board, mode }, i) => {
    const flat = results[i] as string[];
    for (let j = 1; j < flat.length; j += 2) out[board].push({ mode, run: JSON.parse(flat[j]) });
  });
  for (const board of Object.keys(BOARDS) as Board[]) {
    const { direction, value } = BOARDS[board];
    out[board].sort((a, b) => (direction === 'max' ? 1 : -1) * (value(b.run)! - value(a.run)!));
  }
  return out;
}
