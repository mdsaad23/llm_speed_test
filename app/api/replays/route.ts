import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from '@/lib/metrics/results';
import type { Replay } from '@/lib/runner/run';

export const runtime = 'nodejs';

const dir = () => join(RESULTS_DIR, 'replays');

/** Replays are free to watch: this route reads files, it never calls a model. */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!existsSync(dir())) return Response.json([]);

  if (id) {
    // The id goes straight into a path, so only a bare uuid-shaped name is accepted.
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) return Response.json({ error: 'bad id' }, { status: 400 });
    const file = join(dir(), `${id}.json`);
    if (!existsSync(file)) return Response.json({ error: 'unknown replay' }, { status: 404 });
    return new Response(readFileSync(file, 'utf8'), { headers: { 'content-type': 'application/json' } });
  }

  // Stat every file (cheap) to find the newest 100, then parse only those (the part that costs).
  const newest = readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, at: statSync(join(dir(), f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 100);
  const list = newest.map(({ f, at }) => {
    const bareId = f.replace(/\.json$/, '');
    try {
      const { meta } = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as Replay;
      return { id: bareId, at, model: meta.model, mode: meta.mode, timestamp: meta.timestamp };
    } catch {
      return { id: bareId, at, model: bareId, mode: '', timestamp: '' };
    }
  });
  return Response.json(list);
}
