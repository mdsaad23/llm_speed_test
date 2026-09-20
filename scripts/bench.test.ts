import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('headless bench run', () => {
  it('runs 2 levels x 3 tries in two clock modes for $0 and writes all four artefacts', () => {
    const out = mkdtempSync(join(tmpdir(), 'snakebench-'));
    const log = execFileSync(
      'node',
      ['--import', 'tsx', 'scripts/bench.ts',
        '--models', 'baseline:greedy-bfs,mock',
        '--levels', '1,2', '--tries', '3', '--modes', 'deadline,turn',
        '--grid', '10x10', '--obstacles', '4', '--max-calls-per-game', '6', '--yes'],
      { cwd: process.cwd(), env: { ...process.env, SNAKEBENCH_RESULTS_DIR: out }, encoding: 'utf8' },
    );

    expect(log).toContain('worst case spend: $0.0000');
    expect(log).toContain('spent $0.00000');

    const runs = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(runs).toHaveLength(24);
    expect(runs.every((r) => r.cost_usd === 0)).toBe(true);
    expect(new Set(runs.map((r) => r.mode))).toEqual(new Set(['deadline', 'turn']));
    expect(new Set(runs.map((r) => r.level))).toEqual(new Set([1, 2]));

    const decisions = readFileSync(join(out, 'decisions.jsonl'), 'utf8').trim().split('\n');
    expect(decisions.length).toBeGreaterThan(20);

    const csv = readFileSync(join(out, 'summary.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('model,level,mode,tries,best_score');
    expect(csv).toContain('latency_penalty_table');

    expect(readdirSync(join(out, 'replays'))).toHaveLength(24);
  }, 180_000);
});
