https://github.com/user-attachments/assets/5ffc3654-22b4-4561-93d1-ccd0052f5f5d

## Results (snapshot: 2026-09-23)

Every model got the same board: 10×10, level 1, seed 101, with a per-move deadline of 8–10 s. Each game was
capped at 300 moves or 5 minutes. The data covers 94 runs and 6,509 timed decisions in
[`results/`](./results).

- **Moves per food** is decisions divided by score. Lower is better.
- **Time per food** is survival time divided by score.
- **Path** is the moves taken divided by the shortest BFS path. 1.0 is perfect.
- **Hints** add to the prompt which moves are safe and how much each move changes the distance to the food.

### Who won what

| category | winner | number |
|---|---|---|
| overall score | `gemma4:12b-it` (local) | 14 food |
| moves per food | `gpt-luna` | 7.6 |
| time per food | `gemma4:12b-it` (local) | 2.7 s |
| safety | `gpt-luna` | 100% safe moves; the 5-minute clock ended both games |
| fastest response | `minicpm-v` / `llama3.2:3b` | ~90 ms per move, 0 food |
| fastest hosted response | `jev` | ~0.4 s per move, best score 4 |
| reference | greedy BFS script (no LLM) | 25 food, <1 ms per move |

### Every model, 10×10, level 1

Each row shows the model's best run. **Mean** is over all its runs. **Timeouts** and **invalid** are the worst
rates seen in any run.

| model | runs | best | mean | p50 per move | moves per food | time per food | path | safe moves | moves toward food | timeouts | invalid | how it ended |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline:greedy-bfs` | 1 | **25** | 25 | <1 ms | 9.0 | 1.4 s | 1.18 | 100% | 100% | 0% | 0% | death |
| `ollama:gemma4:12b-it-q4_K_M` | 9 | **14** | 10.7 | 0.32–0.98 s | 8.4 | 2.7 s | 0.98 | 99% | 96% | 0% | 0% | death |
| `openrouter:~openai/gpt-luna-latest` | 2 | 12 | 12 | 3.0 s | **7.6** | 25 s | 1.05 | 100% | 99% | 1% | 2% | 5-minute clock (both) |
| `openrouter:~google/gemini-flash-latest` | 2 | 7 | 7 | 4.8–5.3 s | 8.1 | 44 s | 1.04 | 100% | 100% | 4% | 2% | death / clock |
| `openrouter:~anthropic/claude-haiku-latest` | 2 | 2 | 2 | 1.3 s | 14 | 21 s | 1.0 | 96% | 89% | 0% | 0% | death |
| `typesafe:jev-latest` + hints | 3 | 4 | 2.7 | 0.4 s | 75–150 | 31–64 s | 4.3–6.0 | 100% | 53% | 0% | 0% | 300-move cap |
| `openrouter:~deepseek/deepseek-v4-flash-latest` | 2 | 1 | 0.5 | 2.3 s | 10 | 79 s | 1.0 | 100% | 75% | **74%** | 16% | death |
| `typesafe:jev-latest` | 6 | 0 | 0 | 0.4 s | — | — | — | 86% | 50% | 0% | 0% | death at move 7 (all) |
| `laya` | 5 | 0 | 0 | 0.53 s | — | — | — | 80% | 0% | 0% | 0% | death at move 5 (all) |
| `ollama:llama3.2:3b-instruct` (q4, q8) | 5 | 0 | 0 | 90–104 ms | — | — | — | 0% | 100% | 0% | 0% | death at move 5 |
| `ollama:qwen3:14b-q4_K_M` | 7 | 0 | 0 | 0.28 s | — | — | — | 86% | 33% | 0% | 0% | death |
| `ollama:granite4:7b-a1b-h` | 2 | 0 | 0 | 0.20 s | — | — | — | 80% | 0% | 0% | 0% | death |
| `ollama:mistral:7b-instruct-v0.3` | 1 | 0 | 0 | 0.18 s | — | — | — | 89% | 0% | 0% | 0% | death |
| `ollama:llama3.1:8b-instruct` (q8, q4 + hints) | 5 | 0 | 0 | 0.12–0.61 s | — | — | — | 89% | 0% | 0% | 0% | death |
| `ollama:deepseek-r1:8b-llama-distill` | 6 | 0 | 0 | — | — | — | — | — | — | 0% | **100%** | death at move 5 |

On other boards (20×20, or 10×10 at level 2):
- `gemma4` reached 12 food on 20×20 and 3 at level 2.
- `phi4:14b` with hints ate 1 food in 300 moves at level 2.
- `mistral-small-24b` ate 0 on 20×20, both with and without hints; with hints it twice hit the 300-move cap.
- `minicpm-v`, `llama3.2:3b` and `llama3.1:8b` all scored 0 on 20×20.

### Patterns

- **A fast answer is not a fast result.** Jev answered about 7.5× faster than Luna. It still took longer per
  food (31–64 s against 25 s), because it needed 10–20× the moves and walked 4–6× the shortest path.
- **Moves per food is what separates the models.** The top three LLMs needed 7.6–8.4 moves per food, Haiku
  14, and Jev 75–150. Response time didn't predict score: the two fastest models, at about 90 ms, both scored 0.
- **More reasoning didn't buy better paths.** Gemini produced about 414 output tokens per move against Luna's
  140. Its paths were about as short (8.1 against 7.6 moves per food), but each food took 44 s against 25 s,
  and it scored 7 against 12.
- **A 12B model on a laptop beat every hosted model** on score and on time per food. No LLM beat the BFS script.
- **Most models got the same result on every run.** With the same prompt and seed, Gemma, Laya, the Llamas and
  Jev without hints repeated the same game every time, so their repeat runs mostly measure latency. Jev with
  hints varied (2–4 food).

### How models failed

1. **No usable output.** `deepseek-r1:8b` returned no move on every call: its reasoning ran past the token cap
   before a move appeared. `deepseek-v4-flash` answered, but too slowly, and 50–74% of its moves timed out.
2. **Ignoring the board.** Laya answered RIGHT on every move with about the same probability (~0.62), wherever
   the food was. It hit the wall in all 5 runs. `llama3.2:3b` and `granite4` also repeated one direction until
   they hit a wall.
3. **Not correcting course.** Without hints, Jev went UP once and then LEFT six times, past the food's column
   and into the wall. Its confidence rose from 0.40 to 0.71 on the way. This happened in all 6 runs.
4. **Loops.** With hints, models stopped dying but went in circles:
   - `phi4` repeated D-L-L-L-U-R-R-R for about 290 moves.
   - `mistral-small-24b` circled U-L-D-R for over 150 moves.
   - Jev drove long sweeps along the walls.

   Each call has no memory of the moves before it, and choosing only safe moves can cycle forever. Even when
   the prompt said which move got closer to the food, these models took it only about half the time.
   **Hints fixed survival, not navigation.**

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

Out of the box the browser runs the mocks, the baselines, every local Ollama tag, `laya` — the same
typed-decision shape as Jev, but open-weight and CPU-local — and `jev` via the Vercel AI Gateway, billed to
`AI_GATEWAY_API_KEY` and stopped by the "max $ / run" guard. To play Jev on a TypeSafe key instead, pick the
"TypeSafe AI (Jev)" provider below. It reads that list from `/api/models`, which serves the enabled
entries of `models.config.ts`. On Vercel, paid and local-only entries are hidden: a visitor never spends
the server's key. `mock:slow` is the interesting one: it is slow and jittery
enough to drive the board through timeouts, invalid replies and errors without spending anything.

Selecting `laya` in the manual panel spawns `scripts/laya_server.py` itself on first use (needs the one-time
`py -3.12 -m pip install laya` from its docstring), the same "LOADING MODEL" moment as a cold Ollama tag, then
leaves it resident — reloading it costs 7-10s, per its own docs, so it is not re-spawned per game.

The provider dropdown in the manual panel reaches everything else: OpenAI, Anthropic, Google, xAI, Groq,
Together, Mistral, DeepSeek, OpenRouter, the Vercel AI Gateway, and TypeSafe AI (Jev direct from
`api.typesafe.ai`, no gateway — its two model ids come from its docs, since it has no catalogue endpoint,
and `typesafeAdapter` plays it over System One rather than chat). Pick one, paste
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
