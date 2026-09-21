# Results (snapshot: 2026-09-21)

Model-wise numbers from local Ollama runs on this machine, `deadline` mode, best of up to 6 tries per
model so far. Filtered to decisions recorded under the **current** prompt/schema version only —
`results/runs.jsonl` has 57 recorded runs total, but 26 of them predate a prompt or schema fix and are
excluded here rather than averaged in as if they were comparable. `deepseek-r1:8b-llama-distill` has no
current-schema runs at all yet (its only recorded data is stale), so it isn't in the table below; see the
note on it further down.

This is one machine's local Ollama numbers, not a controlled multi-run study — several rows are n=1 or n=2.
Treat single-try rows as "first look," not a verdict.

| model | tries | best score | mean score | p50 latency | safe-move rate | how it ended |
|---|---|---|---|---|---|---|
| `ollama:gemma4:12b-it-q4_K_M` | 6 | **14** | 8.5 | 962 ms | 98% | death, every time |
| `ollama:phi4:14b-q4_K_M` | 1 | 1 | 1.0 | 440 ms | 100% | hit the 300-call cap |
| `ollama:minicpm-v:latest` | 1 | 0 | 0.0 | 87 ms | 90% | death |
| `ollama:llama3.2:3b-instruct-q4_K_M` | 3 | 0 | 0.0 | 90 ms | 90% | death |
| `ollama:llama3.2:3b-instruct-q8_0` | 1 | 0 | 0.0 | 112 ms | 80% | death |
| `ollama:mistral:7b-instruct-v0.3-q4_K_M` | 1 | 0 | 0.0 | 184 ms | 89% | death |
| `ollama:granite4:7b-a1b-h` | 2 | 0 | 0.0 | 194 ms | 80% | death |
| `ollama:mistral-small-24b` | 6 | 0 | 0.0 | 364 ms | 99% | death (4), call cap (2) |
| `ollama:llama3.1:8b-instruct-q8_0` | 4 | 0 | 0.0 | 422 ms | 91% | death |
| `ollama:llama3.1:8b-instruct-q4_K_M` | 2 | 0 | 0.0 | 525 ms | 89% | death |
| `ollama:qwen3:14b-q4_K_M` | 4 | 0 | 0.0 | 595 ms | 86% | death |

`mistral-nemo:12b-instruct-2407-q4_K_M`, `glm4:9b-chat-q4_K_M` and `command-r7b:7b-12-2024-q4_K_M` were
just pulled and are registered in `models.config.ts` — no runs yet, next snapshot.

## What actually happened

**Walked straight into the wall.** `llama3.2:3b` (both quants) and `minicpm-v` answer the same literal
`{"move":"RIGHT"}` on every single call of every game — confirmed by checking whether the move ever varied
with food position (0 of 30 calls did). Their safe-move rate above still reads 80-90%, which undersells the
bug: going straight is "safe" for the several ticks it takes to reach a wall, then it isn't. The scoreboard,
not the per-move metric, is what actually catches this one.

That check is no longer done by hand: every run now records `reference_kappa` (agreement with greedy-BFS,
chance subtracted out) and flags this failure as `state_blind`. The table above predates the metric, so it
does not carry the column — the next snapshot will.

**Ran in circles without finding food.** `mistral-small-24b` didn't die in 2 of its 6 tries — it hit the
300-call ceiling instead, after 222s and 230s of real wall-clock survival, having eaten nothing either time.
Genuinely playing, just never converging on the food.

**Reasoning that never finished.** Not in the table above (its only recorded runs are stale), but
`deepseek-r1:8b-llama-distill` is worth naming: Ollama 0.34 ignores its `think=false` request, so every move
opens with a 1k-4k+ token think block before any JSON move appears. At a 4096-token cap it answered 1 move
in 5 (11.8s each); the other four were cut off mid-thought. `qwen3:14b` is a milder version of the same
problem — also a hybrid reasoner asked to think off — and it's the slowest model that's actually alive in
the table (595ms p50), which tracks.

**Genuinely played.** `gemma4:12b-it` is the only model with real, repeated positive scores — mean 8.5
across 6 tries, best 14, 98% safe-move rate. It still dies every game; it just dies later, having eaten
something first.

**Maybe strategized, ask again once there's more than one data point.** `phi4:14b`'s single run ended by
hitting the call cap with a 100% safe-move rate and one food eaten — the only run in this batch that neither
died nor merely stalled. One try isn't enough to call it, but it's the one to re-run first.

## Speed

The fastest responders in this batch (`minicpm-v` ~87ms, `llama3.2:3b` ~90-112ms) are also the broken ones —
they're fast because they're answering without looking at the board. Among models that are actually alive
past tick one, `gemma4:12b-it` is fastest at 962ms p50; `qwen3:14b`'s reasoning overhead puts it slowest at
595ms among the ones that respond at all (`deepseek-r1`'s 11.8s outlier isn't in this table, see above).

## Reproducing this

```bash
corepack pnpm bench --models ollama:gemma4:12b-it-q4_K_M,ollama:mistral-small-24b --levels 1 --tries 6 --modes deadline
```

Full metric definitions, the three clock modes, and every caveat about what these numbers do and don't mean
are in [`README.md`](./README.md#reading-the-metrics).
