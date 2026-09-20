# SnakeBench — plan

## Verified before building (2026-09-20, from live sources, nothing from memory)

| Thing | Verified value | Source |
|---|---|---|
| AI SDK v7 | `ai@7.0.107` is `latest` (spec floor is 7.0.105) | `npm view ai version` |
| Gateway usage | Plain string model id `provider/model` passed to `generateText`; key from `AI_GATEWAY_API_KEY` in `.env.local`; no separate provider client | https://vercel.com/ai-gateway |
| Jev call shape | `experimental_evaluate` from `ai`; takes `model`, `state`, `questions`, `abortSignal`, `maxRetries`; a `choice` question returns `answers.<id>.choice` + `probabilities`; confidence recorded as `probabilities[choice]` (the typed field the provider spec guarantees) | https://ai-sdk.dev/docs/ai-sdk-core/evaluation |
| Gemini 3.8 Flash id | `google/gemini-3.8-flash` | https://vercel.com/ai-gateway/models/gemini-3.8-flash |
| Gemini 3.8 Flash price | $0.75 / 1M input, $3.75 / 1M output (catalog: `input 0.00000075`, `output 0.00000375`) | `GET https://ai-gateway.vercel.sh/v1/models` |
| Gemini 3.8 Flash lowest reasoning | **`low`**. The live catalog reports `reasoning_options: [{type:"effort", values:["low","medium","high"]}]` — `minimal` exists in Google's native `thinkingConfig.thinkingLevel` but is *not* offered by the Gateway for this model, and thinking cannot be turned off on Gemini 3.x | catalog + https://vercel.com/docs/ai-gateway/models-and-providers/reasoning/google |
| Jev id | `typesafe-ai/jev`, `type: "evaluation"`, context 32000 | catalog |
| Jev price | $0.042 / 1M input, $0 output (`input 0.000000042`, `output 0`) | catalog + https://vercel.com/ai-gateway/models/jev |
| Cancelled-request billing | Gateway proxies the upstream stream and has been reported to bill the **full** completion after a client abort; docs do not promise pro-rating. So an aborted call is charged as: full input + output up to `maxOutputTokens` | https://github.com/vercel/ai/issues/8325 |
| Local models | Only `nomic-embed-text:latest` is pulled on this machine — an embedding model, it cannot play. Ollama adapters ship disabled until a chat tag is pulled | `ollama list` |
| Ollama API | POST `/api/chat` takes `model`, `messages`, `format` (a full JSON schema), `options`, `stream`, `think` (bool or level), `keep_alive`; timings come back as `load_duration`, `prompt_eval_duration`, `eval_duration`, **all in nanoseconds**, with `prompt_eval_count` / `eval_count` tokens | https://github.com/ollama/ollama/blob/main/docs/api.md |

Spec seed prices confirmed: Gemini 3.8 Flash $0.75/$3.75 matches. Jev is $0.042/1M input, not $0.04 (the article rounded); we use the catalog number.

## Build order

1. **Phase 1 ($0)** — `lib/game` pure engine + tests, `lib/decide` prompt/schema/mock/baselines, `lib/metrics`, `lib/runner` (deadline/turn/freerun, budget guard), `scripts/bench.ts`, the four result artefacts.
2. **Phase 2** — gateway + jev + ollama adapters, `models.config.ts`, `pricing.json` (no verified price -> refuse), spend caps + confirmation prompt.
3. **Phase 3** — live UI over SSE, manual mode, replay viewer. Mock and baselines only.

## Decisions where the spec is silent

- **Start cell**: head at `(floor(w/2), floor(h/2))`, body two cells to its left, heading RIGHT.
- **"Within 2 cells of the start path"**: start path = the snake's three cells plus the five cells straight ahead; obstacles must be Chebyshev distance > 2 from all of them.
- **Tail-chase**: moving into the cell the tail is vacating this tick is legal (standard Snake), death otherwise.
- **`min-deadline-ms`** defaults to 250 ms.
- **Reasoning logging**: the requested and accepted reasoning setting is written to every run; a model that refuses "off" runs at its lowest and says so — never a silent fallback.
