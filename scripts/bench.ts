import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import { defaultConfig, type Config } from '@/lib/game/engine';
import { createAdapter, findModel, type ModelEntry } from '@/lib/decide/models.config';
import { requirePrice } from '@/lib/decide/pricing';
import type { ClockMode } from '@/lib/decide/prompt';
import { callCost } from '@/lib/metrics/metrics';
import { writeResults } from '@/lib/metrics/results';
import { newBudget, runGame, type Replay } from '@/lib/runner/run';
import type { DecisionRecord, RunRecord } from '@/lib/metrics/metrics';

const SEEDS = [101, 102, 103];

function args(argv: string[]) {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    map.set(key, next && !next.startsWith('--') ? next : 'true');
  }
  const str = (k: string, d: string) => map.get(k) ?? d;
  const num = (k: string, d: number) => (map.has(k) ? Number(map.get(k)) : d);
  const list = (k: string, d: string) => str(k, d).split(',').map((s) => s.trim()).filter(Boolean);
  const flag = (k: string) => map.get(k) === 'true';
  const [w, h] = str('grid', '20x20').split('x').map(Number);

  return {
    models: list('models', 'baseline:greedy-bfs,mock'),
    levels: list('levels', '1').map(Number) as (1 | 2)[],
    tries: num('tries', 3),
    modes: list('modes', str('clock', 'deadline')) as ClockMode[],
    hints: str('hints', 'off') === 'on',
    w, h,
    obstacles: num('obstacles', 8),
    baseDeadlineMs: num('base-deadline-ms', 8000),
    minDeadlineMs: num('min-deadline-ms', 250),
    maxGameSeconds: num('max-game-seconds', 300),
    maxCallsPerGame: num('max-calls-per-game', 300),
    maxUsdPerRun: num('max-usd-per-run', Infinity),
    maxUsdPerModel: num('max-usd-per-model', Infinity),
    displayMinTickMs: num('display-min-tick-ms', 0),
    localCostPerHour: num('local-cost-per-hour', 0),
    includeFreerun: flag('include-freerun'),
    includeManual: flag('include-manual'),
    yes: flag('yes'),
  };
}

const machine = (): Record<string, string> => ({
  cpu: os.cpus()[0]?.model ?? 'unknown',
  cores: String(os.cpus().length),
  ram_gb: (os.totalmem() / 1024 ** 3).toFixed(1),
  platform: `${os.platform()} ${os.release()}`,
  node: process.version,
  gpu: process.env.SNAKEBENCH_GPU ?? 'unspecified',
  ollama_version: process.env.SNAKEBENCH_OLLAMA_VERSION ?? 'unspecified',
  quantization: process.env.SNAKEBENCH_QUANTIZATION ?? 'unspecified',
});

/** calls/game x games x tokens/call x price, per mode. Printed before anything is spent. */
function worstCaseUsd(entries: ModelEntry[], games: number, a: ReturnType<typeof args>): number {
  let total = 0;
  for (const entry of entries) {
    if (!entry.paid) continue;
    const price = requirePrice(entry);
    total += games * a.maxCallsPerGame * callCost(price, 900, entry.maxTokens);
  }
  return total;
}

async function main() {
  const a = args(process.argv.slice(2));
  const entries = a.models.map(findModel);
  const gamesPerModel = a.levels.length * a.modes.length * a.tries;
  const games = gamesPerModel * entries.length;

  const worstCase = worstCaseUsd(entries, gamesPerModel, a);
  const hardCap = Number(process.env.BUDGET_USD_HARD_CAP ?? 1);
  console.log(
    `${games} games: ${entries.map((e) => e.id).join(', ')} x levels ${a.levels.join(',')} x ${a.modes.join(',')} x ${a.tries} tries`,
  );
  console.log(`worst case spend: $${worstCase.toFixed(4)} (hard cap $${hardCap.toFixed(2)})`);

  if (worstCase > 0) {
    if (worstCase > hardCap) throw new Error('worst case exceeds BUDGET_USD_HARD_CAP — refusing to start');
    if (!a.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('This run spends real money. Type "yes" to continue: ');
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') return console.log('cancelled.');
    }
  }

  const budget = newBudget({ hardCapUsd: hardCap, maxUsdPerRun: a.maxUsdPerRun, maxUsdPerModel: a.maxUsdPerModel });
  const runs: RunRecord[] = [];
  const decisions: DecisionRecord[] = [];
  const replays: Replay[] = [];

  for (let attempt = 1; attempt <= a.tries; attempt++) {
    for (const level of a.levels) {
      for (const mode of a.modes) {
        for (const entry of entries) {
          const cfg: Config = defaultConfig({
            w: a.w, h: a.h, level, obstacleCount: level === 2 ? a.obstacles : 0,
            seed: SEEDS[(attempt - 1) % SEEDS.length],
            baseDeadlineMs: a.baseDeadlineMs, minDeadlineMs: a.minDeadlineMs,
            maxGameSeconds: a.maxGameSeconds, maxCallsPerGame: a.maxCallsPerGame,
          });
          const run_id = `${entry.id}_L${level}_${mode}_t${attempt}_${Date.now()}`.replace(/[^\w.-]/g, '-');
          process.stdout.write(`${run_id} ... `);

          const result = await runGame({
            cfg,
            adapter: createAdapter(entry, cfg.seed),
            mode,
            hints: a.hints,
            price: requirePrice(entry),
            maxTokens: entry.maxTokens,
            turnTimeoutMs: entry.timeoutMs || 30_000,
            displayMinTickMs: a.displayMinTickMs,
            budget,
            meta: {
              run_id,
              model: entry.id,
              route: entry.route,
              reasoning: entry.reasoning,
              reasoning_requested: entry.reasoning,
              try: attempt,
              timestamp: new Date().toISOString(),
              client_region: process.env.SNAKEBENCH_REGION ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
              machine: machine(),
              manual: false,
            },
          });

          runs.push(result.run);
          decisions.push(...result.decisions);
          replays.push(result.replay);
          console.log(
            `score ${result.run.score} · ${result.run.end_reason} · p50 ${result.run.latency_p50_ms ?? '-'}ms · $${result.run.cost_usd.toFixed(5)}`,
          );
        }
      }
    }
  }

  writeResults(runs, decisions, replays, { includeFreerun: a.includeFreerun, includeManual: a.includeManual });
  console.log(`\nspent $${budget.spent.toFixed(5)}. Wrote results/runs.jsonl, decisions.jsonl, summary.csv, replays/.`);
  if (a.localCostPerHour) {
    const hours = runs.reduce((t, r) => t + r.survival_seconds, 0) / 3600;
    console.log(`local machine cost at $${a.localCostPerHour}/h: $${(hours * a.localCostPerHour).toFixed(4)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
