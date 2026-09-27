import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.SNAKEBENCH_RESULTS_DIR = mkdtempSync(join(tmpdir(), 'snakebench-ui-'));
const { POST } = await import('./route');

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/run', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

const game = {
  model: 'mock', mode: 'deadline', hints: false, try: 1, manual: true,
  displayMinTickMs: 0, maxUsdPerRun: 1,
  cfg: {
    w: 8, h: 8, level: 1, obstacleCount: 0, seed: 101, baseDeadlineMs: 500, minDeadlineMs: 100,
    paceFactor: 1.05, baseSpeedCps: 2, maxGameSeconds: 20, maxCallsPerGame: 4,
  },
};

describe('live run endpoint', () => {
  it('streams a whole game and saves a replay', async () => {
    const res = await post(game);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.slice(6)));

    expect(events[0].type).toBe('start');
    expect(events.filter((e) => e.type === 'pending').length).toBeGreaterThan(0);
    expect(events.at(-1).type).toBe('end');
    expect(events.at(-1).run.cost_usd).toBe(0);
    expect(readdirSync(join(process.env.SNAKEBENCH_RESULTS_DIR!, 'replays'))).toHaveLength(1);
  }, 30_000);

  it('refuses a disabled model', async () => {
    const res = await post({ ...game, model: 'gemini-3.8-flash' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/disabled/);
  });

  it('rejects an out-of-range configuration', async () => {
    const res = await post({ ...game, cfg: { ...game.cfg, w: 2 } });
    expect(res.status).toBe(400);
  });

  it('on Vercel, plays only on a key the visitor pasted', async () => {
    process.env.VERCEL = '1';
    process.env.OPENAI_API_KEY = 'server-key';
    try {
      for (const model of ['mock', 'baseline:greedy-bfs', 'ollama:phi4:14b-q4_K_M', 'laya', 'jev']) {
        expect((await post({ ...game, model })).status).toBe(400);
      }
      const unkeyed = await post({ ...game, model: 'gpt-5', provider: 'openai', apiKey: '  ' });
      expect(unkeyed.status).toBe(400);
      expect((await unkeyed.json()).error).toMatch(/needs an API key/);
    } finally {
      delete process.env.VERCEL;
      delete process.env.OPENAI_API_KEY;
    }
  });
});
