# SnakeBench

How fast can a model decide? Every model plays Snake under a deadline that shrinks as it scores, and every
decision is timed, priced and shown live.

Runs locally only. Nothing is deployed, nothing is reported anywhere, and the whole test suite costs $0.

Model-wise scores and behavior for every local model tested so far: [`RESULTS.md`](./RESULTS.md).

## Setup

```bash
corepack pnpm install
cp .env.example .env.local     # only needed for paid models
```

`.env.local` is gitignored. `AI_GATEWAY_API_KEY` is only read when you name a Gateway model;
`BUDGET_USD_HARD_CAP` (default `1.00`) is the last line of defence and is checked before every call.

## Running it

**Headless (the benchmark):**

```bash
corepack pnpm bench --models baseline:greedy-bfs,mock --levels 1,2 --tries 3 --modes deadline,turn
```

It prints a worst-case spend estimate before anything runs and waits for you to type `yes` (`--yes` skips the
prompt, which is what the test suite uses). Useful flags: `--grid 10x10`, `--obstacles 8`, `--base-deadline-ms`,
`--min-deadline-ms`, `--max-calls-per-game`, `--max-usd-per-run`, `--max-usd-per-model`, `--hints on`,
`--display-min-tick-ms`, `--include-freerun`, `--include-manual`.

Results land in `results/`:

| file | what it holds |
|---|---|
| `runs.jsonl` | one line per game, every §4 metric |
| `decisions.jsonl` | one line per decision |
| `summary.csv` | official runs only, grouped by model × level × mode, plus a latency-penalty table |
| `replays/<run_id>.json` | every frame and decision, enough to replay the game for free |

**Live (the UI):**

```bash
corepack pnpm dev      # http://localhost:3000
```

Out of the box the browser runs free models: the mocks, the baselines and every local Ollama tag. It reads that
list from `/api/models`, which serves the enabled, unpaid entries of `models.config.ts`. Models billed to the
server's own key stay CLI-only, where the estimate and confirmation live. `mock:slow` is the interesting one:
it is slow and jittery enough to drive the board through timeouts, invalid replies and errors without spending
anything.

The provider dropdown in the manual panel reaches everything else: OpenAI, Anthropic, Google, xAI, Groq,
Together, Mistral, DeepSeek, OpenRouter and the Vercel AI Gateway (which is where Jev lives). Pick one, paste
your own key, and `/api/models?provider=` proxies that provider's catalogue — fetched from the provider on
every load, never a list copied into this repo. OpenRouter and the Gateway list without a key. One adapter
(`openaiCompatAdapter`) plays them all over `/chat/completions`, and a provider that rejects the strict move
schema gets one retry with the optional knobs dropped. Your key is sent to this app only for the listing and
the run: it is never persisted, logged, or written to a result or replay. Those runs are billed by your
provider, so the `$/run` guard — which only governs keys on the server — does not bound them; the per-game
call and time caps do.

Tick the models you want in the manual panel, from as many providers as you like, and the browser plays
them one at a time, model × try, with the leaderboard filling up as they finish. One game at a time: a local
GPU has no parallelism to give. Each Ollama run is warmed up before the clock starts — the header says
`LOADING MODEL` while a cold 26B lands in VRAM — and the weights are released the moment the run ends, so the
next model is not measured through a full GPU.

## The three clocks

| mode | what happens | what it measures |
|---|---|---|
| `deadline` | one request per tick with `deadline_ms` in the state; a late answer is aborted and discarded, and the snake goes straight | can the model answer in time, as time runs out |
| `turn` | the board waits for the answer, no deadline (safety timeout only) | pure latency; `turn p50 − deadline p50` is the latency penalty |
| `freerun` | the snake keeps moving at `speed_cps`; the answer lands on a later tick, tagged with its staleness | a demo, not a benchmark — excluded from `summary.csv` unless `--include-freerun` |

The pace after `k` foods is `1.05^k`: the deadline becomes `base_deadline_ms / 1.05^k` (floored at
`--min-deadline-ms`), and in freerun the speed becomes `base_speed_cps * 1.05^k`. One request is in flight at a
time, one call per tick, no retries and no batching. Display pacing (`--display-min-tick-ms`) only slows the
picture down; it happens after a move is applied and can never touch a latency or a deadline.

## Manual mode

The panel under the board edits the grid, level and obstacle count, seed, clock, base and minimum deadline,
pace factor, speed, game length, call cap, hints, tries, display pacing and per-run spend cap. Impossible
configurations are blocked before Start, and anything that differs from the official settings (20×20, level 1
or 2, seeds 101/102/103, 8 s base deadline, hints off) is recorded with `manual: true` and kept out of
`summary.csv` unless you pass `--include-manual`. Reasoning effort and `max_tokens` are per-model and live in
`lib/decide/models.config.ts`.

## Reading the metrics

- **Speed** — `latency_p50/p95/p99` cover completed calls only. The `latency_lb_*` figures are the honest
  lower bound: every timeout is counted as the deadline it blew, because the real latency is unknown.
- **Deadline** — `deadline_at_death_ms` is how much time the model had left when it died; `first_timeout_food`
  is the score at which it first ran out; `predicted_breakpoint_k` is the first `k` where
  `base / 1.05^k` drops below the model's own p50 (from `turn` mode when you have it), and
  `actual_breakpoint_k` is where the timeouts really started.
- **Cost** — `cost_per_move_usd` counts timeouts too, because an aborted call is still billed. Those calls are
  flagged `cost_estimated: true`: input in full, output up to `max_tokens`.
- **Tokens** — `tokens_per_sec_basis` says which clock was used: `first_token` when the adapter streams,
  `call_duration` otherwise.
- **Quality** — `safe_move_rate` (did the move avoid an immediate death), `food_approach_rate` (did BFS
  distance to the food go down), `path_efficiency` (shortest path ÷ ticks actually taken).
- **Against the baseline** — `baseline_score` is what `baseline:greedy-bfs` scores on that exact board, and
  `score_normalized` is the run's score over it. 1.0 is the reference policy's own result, so a score is
  comparable across grids, levels and seeds in a way a raw count is not. The baseline is deterministic and
  reads no clock, so the denominator never depends on how busy the machine was.
- **Is it reading the board?** — `reference_move` on every decision is what greedy-BFS would have played on
  that same board, which makes the model's move testable against something. `reference_agreement` is how
  often they matched; `reference_kappa` is that agreement with chance subtracted out (Cohen's kappa), which
  is the number to read. Raw agreement flatters a model that answers one literal move every turn — it
  collects every board where that move happened to be right — while kappa puts it at ~0 however lucky the
  move is. `move_entropy` (0 = one move all game, 1 = an even spread over all four compass moves) and
  `distinct_moves` are the raw evidence next to it. `state_blind` is a screening flag, not a verdict: the
  moves carry no more information about the board than chance would give. See the caveat below before
  quoting it.
- **Endings** — `end_reason` with `censored: true` means the game was cut short by a cap, the time limit or an
  abort. Those scores are lower bounds, not results.

Headline score is best of 3 tries; the mean, median and every individual try are kept.

## Caveats

- Latency is measured server-side, as tightly around the provider call as possible (`performance.now()` at
  request, first token, completion). Network distance to the provider is part of the number.
- A timeout has no latency, only a lower bound. Percentiles over completed calls flatter a model that times
  out often; read them next to `timeout_rate` and the `latency_lb_*` columns.
- Prices come from `lib/decide/pricing.json` with a `source_url` and a `verified_at` date. A paid model with
  no verified price refuses to run. Verify them again before you trust a cost.
- Reasoning is requested off, or at the provider's lowest accepted setting when off is not offered — Gemini
  3.8 Flash's floor on the Gateway is `low`. The requested and effective settings are both recorded; nothing is
  silently downgraded.
- Local (Ollama) runs depend on your machine and what else it is doing. Set `SNAKEBENCH_GPU`,
  `SNAKEBENCH_OLLAMA_VERSION` and `SNAKEBENCH_QUANTIZATION` so the run records what it ran on.
- Freerun is a demo. It is not comparable with the other two clocks.
- `state_blind` flags a run for a look, it does not settle it. Greedy-BFS is myopic, so a model that plays
  for survival over greed can sit low on kappa while reading the board perfectly well; read `move_entropy`
  alongside it, since a stuck answer reads 0 there and a disagreeing model reads high. The threshold is
  deliberately low on decisions (8), because a model that answers one fixed move walks into the nearest wall
  in about ten moves and a higher bar would never fire on exactly the models it is for — the price is noise
  on a single try, which is what `state_blind_runs` in `summary.csv` is for. One flagged try is a look;
  three of three is the finding.

## Layout

```
lib/game/     pure engine + tests (seeded, deterministic, no game library), greedy-BFS reference policy
lib/decide/   prompt and schema (one file), adapters, models.config.ts, pricing.json
lib/metrics/  per-decision and per-game metrics, result files
lib/runner/   the game loop, clocks, budget guard
app/          live UI (SSE), replay viewer, /api/run and /api/replays
scripts/      pnpm bench
```

`pnpm test`, `pnpm typecheck` and `pnpm lint` all run without touching a paid provider.
