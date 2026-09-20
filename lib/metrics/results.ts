import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summaryCsv, type DecisionRecord, type RunRecord } from '@/lib/metrics/metrics';
import type { Replay } from '@/lib/runner/run';

export const RESULTS_DIR = process.env.SNAKEBENCH_RESULTS_DIR ?? join(process.cwd(), 'results');

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

export function writeResults(
  runs: RunRecord[],
  decisions: DecisionRecord[],
  replays: Replay[],
  opts: { includeFreerun: boolean; includeManual: boolean },
) {
  mkdirSync(join(RESULTS_DIR, 'replays'), { recursive: true });
  appendFileSync(join(RESULTS_DIR, 'runs.jsonl'), jsonl(runs));
  appendFileSync(join(RESULTS_DIR, 'decisions.jsonl'), jsonl(decisions));
  for (const replay of replays) {
    writeFileSync(join(RESULTS_DIR, 'replays', `${replay.run_id}.json`), JSON.stringify(replay));
  }
  const official = runs.filter(
    (r) => (opts.includeFreerun || r.mode !== 'freerun') && (opts.includeManual || !r.manual),
  );
  writeFileSync(join(RESULTS_DIR, 'summary.csv'), summaryCsv(official));
}
