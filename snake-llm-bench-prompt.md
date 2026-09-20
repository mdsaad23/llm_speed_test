# SnakeBench — benchmark LLMs playing Snake under a shrinking time limit

Local web app + headless runner: LLMs (cloud and local) pick a snake's moves; measure speed and quality, showing every decision live. **Read jev-pong first** (https://github.com/ably-labs/jev-pong) and mirror it: pure deterministic tested engine, one shared prompt file, tiny numeric state, structured output at temp 0, reasoning off, no retries, latency timed tightly around the call server-side, gated paid paths, a referee for stuck games. The owner pays out of pocket: **cost control is a hard requirement** (§5); everything must build and test at $0 on mock and non-LLM bots.

**Verify from current official docs, never memory — no guessed IDs, params or prices:** AI SDK v7 (`ai` >= 7.0.105) + AI Gateway (https://vercel.com/ai-gateway); Jev `typesafe-ai/jev` via `experimental_evaluate` (https://ai-sdk.dev/docs/ai-sdk-core/evaluation); the Gateway ID and lowest reasoning setting for Gemini 3.8 Flash; local tags (`ollama list`, https://ollama.com/library); how each provider bills a cancelled request. Then a short `PLAN.md` and build; ask only for keys, local models, hardware.

## 1. Game rules (exact)
- Grid 20x20 default, configurable; walls kill, no wrap; `x` right, `y` down, `(0,0)` top-left.
- Start length 3, fixed cell, RIGHT, same for all models. `UP|DOWN|LEFT|RIGHT`; 180° reversal illegal → ignore, go straight, count `rejected_reversal`.
- One food at a time on a seeded random free cell; score = foods, +1 length each.
- Pace after `k` foods `P_k = 1.05^k`: deadline → `deadline_k = base_deadline_ms / P_k` (default 8000, floor via `--min-deadline-ms`); turn → shown only; freerun → `speed_cps = base_speed_cps * P_k` (default 2/s).
- Death: head into wall, obstacle or snake. End: death, grid full, `max_game_seconds` (300, warm-up excluded), stall (no food in `3*w*h` ticks), `call_cap`, budget cap, repeated errors — record the reason; cap and time-limit endings are right-censored, flag them.
- L1 no obstacles; L2 `N` obstacles (default 8), seeded, none within 2 cells of the start path, free cells one connected region (flood fill), food reachable. Test both.
- 3 tries per level on seeds `101,102,103`, **the same for every model and mode**. Headline = best of 3; keep all tries, mean, median.

## 2. Clock modes (`--clock deadline|turn|freerun`, default deadline; `--modes` takes several)
LLMs take seconds; a moving snake would apply late answers to a board the model never saw. Hence: **board frozen while a decision is pending, each request carrying the exact state, late answers discarded**; pressure from the shrinking limit.

**deadline** — per tick: snapshot `S`, send exactly one request with `S` and `deadline_ms`, start a `deadline_k` timer, then whichever comes first:
- valid reply in time → apply to `S`, one step (staleness always zero);
- deadline → abort (`AbortController`), **discard any late answer**, step straight on the current heading, record `timeout`, censor latency (`latency_ms = null`, `censored_at_ms = deadline_k`);
- invalid/empty → step straight at once, record `invalid`;
- error (4xx/5xx, rate limit, auth, credits) → step straight, record `error`, never retry; abort the run on auth/credit errors, end the game after 3 running.
Then a fresh snapshot each tick.

**turn** — game waits, no deadline (safety timeout only, default 30 s), one call per tick, latency measured not enforced. turn minus deadline score = latency penalty; report it.

**freerun** (optional demo, not official) — snake moves at `speed_cps` while the model answers; one request in flight, its reply applied at the next tick with staleness recorded. Not comparable: label it, exclude from `summary.csv` unless `--include-freerun`.

All modes: one request in flight, one call per tick, no queue, batching or retry ever; every request carries the state as sent. Display pacing (`--display-min-tick-ms`, 0 headless / 150 UI) may hold a move visually after the answer, never changing latency or the deadline.

## 3. Model input and output
All prompt text and the schema in one file (`lib/decide/prompt.ts`), one variant per mode, hashed as `prompt_version`. The prompt states: coordinates; death on wall, obstacle or snake; no reversing; food = +1 score, +1 length, shorter limit; board paused while deciding; (deadline) a reply later than `deadline_ms` is discarded and the snake steps straight, so answer at once with just the move; goal = survive and reach food efficiently; answer UP, DOWN, LEFT or RIGHT.

State — compact JSON, no prose, last so caching hits the static prefix; `snake` head-first; `deadline_ms` in deadline mode, `speed_cps` + `tick_ms` in freerun:
```json
{"grid":{"w":20,"h":20},"tick":41,"score":3,"deadline_ms":4900,"dir":"RIGHT","snake":[[9,4],[8,4],[7,4]],"food":[14,4],"obstacles":[[3,3],[10,9]]}
```

Hints (`--hints off|on`, default off, always recorded): on adds per-direction safety flags and the food delta to the state — speed-biased.

Output: structured `{ "move": "UP"|"DOWN"|"LEFT"|"RIGHT" }`. Chat models: temp 0, `max_tokens` ~16, structured/enum output, reasoning off or lowest accepted, no retries; if a provider refuses "off", use its lowest and log it per model — never silently fall back. Jev is typed-decision: `experimental_evaluate`, same state and instructions, a `choice` over the four moves; record its confidence.

## 4. Metrics
One line per decision, one per game; p50/p95/p99 where listed; every game metric per model x level x mode.

Owner's asks: response time per call (request sent → parsed valid move): mean/p50/p95/p99/max over completed calls, timeout rate, lower-bound percentiles counting each timeout as `deadline_k`; highest score per model/level/mode (best of 3) with all tries, mean, median; cost per move (timeouts included); cost per second (game cost ÷ wall-clock seconds, waiting in, warm-up out); tokens/sec = `output_tokens / (t_end - t_first_token)`, else `output_tokens / call_duration` — label which, plus TTFT and total call time; avg time to food (s and ticks), decisions per food.

Also: survival (s, ticks), final length, foods/min, deadline per call, `deadline_at_death_ms`, `first_timeout_food`, timeouts per 10-food bracket, mean margin (`deadline - latency`), predicted vs actual breakpoint (first `k` with `base_deadline_ms / 1.05^k` < turn p50), latency penalty, end reason + `censored`, invalid/timeout/error rates, `rejected_reversal`, tokens per call (input/output/reasoning/total; estimated + `cost_estimated: true` when aborted), safe-move rate, food-approach rate (BFS distance down), path efficiency (steps per food ÷ shortest BFS), score per dollar, Jev confidence.

Metadata: model, route, reasoning setting, `prompt_version`, hints, mode, base deadline, seed, level, try, grid, timestamp, client region, machine specs (CPU/GPU/RAM, Ollama version, quantization), manual parameters.

Baselines ($0): `baseline:random` and `baseline:greedy-bfs` through the same engine and metrics — instant, never timing out.

## 5. Providers and budget guardrails
One interface, `decide(state, { signal }) -> { move, timing, usage, raw }`; every adapter honours `AbortSignal`. `mock` (latency, error and invalid-reply rates configurable — UI and tests at $0); `baseline:*`; `gateway:<model-id>` via AI SDK v7; `gateway:typesafe-ai/jev`; `ollama:<tag>` at `http://localhost:11434` — `keep_alive` on, warm-up call per game excluded from stats, capture Ollama's timing fields; an abort may not stop generation, so a lingering one must not delay the next call or count as latency. One `models.config.ts` (id, provider, reasoning, timeout, enabled).

- `pricing.json`: per-1M input/output price per cloud model with `source_url`, `verified_at`. **No verified price → refuse to run it**; never assume $0. Check these seeds: Gemini 3.8 Flash $0.75 in / $3.75 out per 1M, introductory to Dec 31 2026 (https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/); Jev listed at $0.04/1M input (https://runtimewire.com/article/diogo-almeida-typesafe-jev-40m-seed-pong). Local $0, optional `--local-cost-per-hour`.
- Cost per call = usage x pricing; log the Gateway's own cost, flag mismatches. Aborted calls still cost: until docs say otherwise bill input in full (tokenizer or running average) and output up to `max_tokens`, flag `cost_estimated: true`, count it in cap checks.
- Caps checked before each call: `BUDGET_USD_HARD_CAP` (default 1.00), `--max-usd-per-run`, `--max-usd-per-model`, `--max-calls-per-game` (300, reason `call_cap`), `max_game_seconds` (300). On a cap: end gracefully, record the reason, save partials, stop.
- Any paid run first prints a worst-case estimate (calls/game x games x avg tokens x price, per mode) and waits for confirmation; same in the UI's Start dialog.
- Free first (local + baselines, deadline and turn); paid default `--modes deadline`, turn opt-in; `--models` and `--tries 1` for smoke tests; first paid run = 1 model, 1 level, 1 try. Sequential, one game at a time, tries interleaved across models.
- Never retry a paid call; surface `out_of_credits` and rate limits. Keys only in `.env.local` (gitignored), ship `.env.example`, localhost only, no deployment. Replays free.

## 6. Stack, structure, outputs
TypeScript, Next.js App Router + Tailwind, AI SDK v7, `pnpm`, Vitest. Model calls server-side; state to the browser over Server-Sent Events (no external realtime service); canvas board; no game-engine library. Monotonic `performance.now()`: `t_request_sent`, `t_first_token`, `t_response_complete` or `t_aborted`, `t_move_applied`.

`lib/game/` pure engine (state, step, seeded RNG, level generation, connectivity, pace/deadline math) + tests; `lib/decide/` prompt, schema, adapters; `lib/metrics/` timing, cost, aggregation; `lib/runner/` modes, aborts, budget guard, referee; `app/` dashboard, replay viewer, routes; `scripts/` CLI (`pnpm bench --models ... --levels 1,2 --tries 3 --modes deadline,turn`).

`results/`: `runs.jsonl` per game (every §4 metric + metadata); `decisions.jsonl` per call (tick, deadline, move, `latency_ms` or null, `timed_out`, status, tokens, cost, `cost_estimated`, raw reply); `summary.csv` per model x level x mode (§4 headlines + total cost) + latency-penalty table; `replays/{run_id}.json`.

## 7. UI (live)
**Palette: no LLM blue/purple/indigo.** Beige, olive green and rust with clay, mustard/ochre, warm charcoal ink, cream surfaces, warm dark background. High contrast, monospaced numerals, every status readable by shape, icon or label as well as colour — olive vs rust never the only difference.

Layout: header top, board left, live metrics rail right of the board, feed and charts below. Header: model, level, try (n/3), mode badge, status, run queue, spend meter (spent vs cap, warning colour near the cap), Start (with the §5 confirm dialog), Abort.

Board (canvas): snake with distinct head, food, obstacles, grid; live score, length, pace, current deadline. Overlays: while waiting, slight dim + head spinner + elapsed-ms timer; a deadline bar above the board (full = current `deadline_ms`, fill = elapsed, rust near expiry); on timeout flash "TIMEOUT: going straight, late answer discarded"; on a valid answer an arrow at the head with its latency.

Live metrics rail, right of the board: headline numbers always visible: latency p50/p95, timeout rate, score, length, current deadline, cost per move, cost so far, avg time to food, safe-move rate. Below them an expander showing every §4 metric grouped by type — Speed; Score & survival; Deadline (incl. predicted vs actual breakpoint, latency penalty); Cost (incl. score per dollar, estimate flags); Tokens; Decision quality (incl. Jev confidence); Errors (incl. end reason); Run metadata — each group collapsing on its own.

Manual mode: a panel running one game under full control. Pick one model (or baseline/mock) and edit before starting: grid width and height, level and obstacle count, seed, clock mode, time limit per turn (`base_deadline_ms`, optional min deadline), overall time limit per game (`max_game_seconds`), base speed (`base_speed_cps`, freerun), pace factor, max calls per game, hints, tries, display pacing, reasoning setting, `max_tokens`, per-run USD cap. Validate ranges, block what the engine can't satisfy (e.g. obstacles that disconnect the grid), recompute worst-case spend live as parameters change, same confirm dialog for paid models, plus presets and reset. All manual parameters go into `runs.jsonl`; manual games are `manual: true`, excluded from official `summary.csv` unless `--include-manual`.

Decision feed: scrolling table, newest first — tick, deadline, latency (or "timeout, ≥ deadline"), move, tokens in/out, cost, status; the in-flight call a live row with a running timer.

Deadline vs latency chart: x = foods (or tick), y = ms — the falling deadline curve plus a dot per call, timeouts marked distinctly, with a sparkline of the last 50 latencies and running percentiles. Leaderboard, live, sortable: models x (L1 and L2 best-of-3 in deadline; same in turn when run; latency penalty; median latency; timeout rate; cost per move; total cost). freerun only: ghost arrow for the pending move, staleness badge, "not comparable" banner. Replay viewer: any saved run, scrub/play 1x/2x/4x, same overlays, rail, chart and feed, zero API calls.

## 8. Phases and acceptance
Commit each phase, tests/typecheck/lint green: (1) engine + baselines + mock + headless runner, all three modes, metrics, result files, free; (2) providers + budget guard; (3) live UI + manual mode + replay viewer on mock and baselines only, with a slow jittery mock.

Tests must show: determinism (same seed + moves → identical game); exact `P_k`, `deadline_k`, length `3 + k`; L2 layouts identical per seed, food reachable; a slow mock reply never applied in deadline mode (straight step, aborted request, `timeout`) and a fast one applied to the state sent; turn measuring a slow reply without timing it out; display pacing changing no latency; never >1 in-flight request or >1 call per tick, no retries; caps stopping a mock expensive provider mid-game with aborted calls flagged `cost_estimated: true`; an unpriced cloud model refusing to run; a 2-level x 3-try mock/baseline run in deadline and turn costing $0 and producing all four artefacts. README: setup, both run paths, the three clocks, manual mode, reading the metrics, caveats (network latency included, provider load varies, tokens/sec noisy, timeouts censored, capped games right-censored).

## 9. Do not
No deployment, analytics or telemetry; never apply a late reply to a newer state (except the labelled freerun demo); no retries, hidden model fallbacks or latency-hiding batching; no paid models in development or tests; no prices, IDs or params from memory; no concurrent games in benchmark mode.

Finally report: what was built, how to run it, what you verified (with links), choices made where the spec was silent, anything unverified.