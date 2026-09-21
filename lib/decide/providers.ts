import { experimental_evaluate, generateObject } from 'ai';
import { z } from 'zod';
import { MOVE_MEANING, legalMoves, moveSchema, moveSchemaFor, stateJson, systemPrompt } from '@/lib/decide/prompt';
import { now, type Adapter, type DecideContext, type Decision, type Usage } from '@/lib/decide/adapters';
import type { ModelEntry } from '@/lib/decide/models.config';
import type { Dir } from '@/lib/game/engine';

type Reasoning = NonNullable<Parameters<typeof generateObject>[0]['reasoning']>;

const parseMove = (value: unknown): Dir | null => {
  const parsed = moveSchema.safeParse(value);
  return parsed.success ? parsed.data.move : null;
};

const reported = new Set<string>();

/** A provider that will not honour the requested reasoning setting says so, once, out loud. */
function reportWarnings(entry: ModelEntry, warnings: readonly { type?: string; message?: string }[] | undefined) {
  if (!warnings?.length || reported.has(entry.id)) return;
  reported.add(entry.id);
  console.warn(`[${entry.id}] provider warnings: ${warnings.map((w) => w.message ?? w.type).join('; ')}`);
}

interface RawUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  outputTokenDetails?: { reasoningTokens?: number | undefined };
}

const toUsage = (u: RawUsage): Usage => ({
  input: u.inputTokens ?? 0,
  output: u.outputTokens ?? 0,
  reasoning: u.outputTokenDetails?.reasoningTokens ?? 0,
  total: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
  estimated: false,
});

const gatewayCost = (metadata: unknown): number | null => {
  const cost = (metadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost;
  const value = Number(cost);
  return Number.isFinite(value) ? value : null;
};

/** Any Gateway chat model: structured output, temperature 0, no retries, abort honoured. */
export const gatewayAdapter = (entry: ModelEntry): Adapter => ({
  id: entry.id,
  paid: true,
  streams: false,
  async decide({ state, cfg, mode, hints, signal }: DecideContext): Promise<Decision> {
    const tRequestSent = now();
    const result = await generateObject({
      model: entry.route,
      schema: moveSchemaFor(state.dir),
      system: systemPrompt(mode),
      prompt: stateJson(state, cfg, mode, hints),
      temperature: 0,
      maxOutputTokens: entry.maxTokens,
      maxRetries: 0,
      reasoning: entry.reasoning as Reasoning,
      abortSignal: signal,
    });
    reportWarnings(entry, result.warnings);
    return {
      move: parseMove(result.object),
      timing: { tRequestSent, tFirstToken: null, tResponseComplete: now() },
      usage: toUsage(result.usage),
      raw: JSON.stringify(result.object),
      gatewayCostUsd: gatewayCost(result.providerMetadata),
    };
  },
});

/** TypeSafe AI's Jev is a typed-decision model: one choice question over the four moves. */
export const jevAdapter = (entry: ModelEntry): Adapter => ({
  id: entry.id,
  paid: true,
  streams: false,
  async decide({ state, cfg, mode, hints, signal }: DecideContext): Promise<Decision> {
    const tRequestSent = now();
    const result = await experimental_evaluate({
      model: entry.route,
      state: JSON.parse(stateJson(state, cfg, mode, hints)),
      questions: {
        move: {
          type: 'choice',
          instructions: systemPrompt(mode),
          criteria: Object.fromEntries(legalMoves(state.dir).map((d) => [d, MOVE_MEANING[d]])),
        },
      },
      maxRetries: 0,
      abortSignal: signal,
    });
    reportWarnings(entry, result.warnings);
    const answer = result.answers.move;
    return {
      move: parseMove({ move: answer.choice }),
      timing: { tRequestSent, tFirstToken: null, tResponseComplete: now() },
      usage: toUsage(result.usage),
      raw: JSON.stringify(answer),
      confidence: answer.probabilities?.[answer.choice] ?? null,
    };
  },
});

const OLLAMA_HOST = () => process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const NS_PER_MS = 1e6;

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  done_reason?: string;
  prompt_eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

async function ollamaChat(entry: ModelEntry, system: string, user: string, format: unknown, signal: AbortSignal) {
  const response = await fetch(`${OLLAMA_HOST()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: entry.route,
      stream: false,
      think: false,
      keep_alive: '10m',
      format,
      options: { temperature: 0, num_predict: entry.maxTokens },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`ollama ${response.status}: ${await response.text()}`);
  return (await response.json()) as OllamaChatResponse;
}

/**
 * Local models are free but not instant. An aborted request may leave Ollama generating,
 * so nothing here waits on the old call: the next tick opens a fresh one.
 */
export const ollamaAdapter = (entry: ModelEntry): Adapter => ({
  id: entry.id,
  paid: false,
  streams: false,
  async warmup(cfg) {
    const signal = AbortSignal.timeout(entry.timeoutMs || 120_000);
    const format = z.toJSONSchema(moveSchemaFor('RIGHT'));
    await ollamaChat(entry, systemPrompt('deadline'), `{"grid":{"w":${cfg.w},"h":${cfg.h}},"warmup":true}`, format, signal);
  },
  async unload() {
    await fetch(`${OLLAMA_HOST()}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: entry.route, keep_alive: 0 }),
    }).catch(() => {});
  },
  async decide({ state, cfg, mode, hints, signal }: DecideContext): Promise<Decision> {
    const tRequestSent = now();
    const format = z.toJSONSchema(moveSchemaFor(state.dir));
    const body = await ollamaChat(entry, systemPrompt(mode), stateJson(state, cfg, mode, hints), format, signal);
    const tResponseComplete = now();
    // Empty content is almost always a token budget eaten by an unstoppable <think>; say so in the record.
    const raw = body.message?.content || (body.done_reason ? `<no answer: done_reason=${body.done_reason}>` : '');
    const firstTokenNs = (body.load_duration ?? 0) + (body.prompt_eval_duration ?? 0);
    return {
      move: parseMove(safeJson(raw)),
      timing: {
        tRequestSent,
        tFirstToken: firstTokenNs ? tRequestSent + firstTokenNs / NS_PER_MS : null,
        tResponseComplete,
      },
      usage: toUsage({ inputTokens: body.prompt_eval_count, outputTokens: body.eval_count }),
      raw,
    };
  },
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface ProviderSpec {
  label: string;
  /** OpenAI-compatible base: `${base}/models` lists the catalog, `${base}/chat/completions` plays. */
  base: string;
  /** Public catalogs can be browsed before a key exists. */
  keylessList?: boolean;
  /** Google lists ids as "models/gemini-x"; chat wants the bare name. */
  strip?: string;
  /** Anthropic lists with its own header pair; everyone else takes a bearer token. */
  listHeaders?: (key: string) => Record<string, string>;
}

/**
 * Bring-your-own-key providers. No model list is written down here: every catalog is fetched
 * from the provider itself on request. Endpoints and auth styles probed against the live APIs.
 */
export const PROVIDERS = {
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1' },
  anthropic: {
    label: 'Anthropic',
    base: 'https://api.anthropic.com/v1',
    listHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  google: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    strip: 'models/',
  },
  xai: { label: 'xAI Grok', base: 'https://api.x.ai/v1' },
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1' },
  together: { label: 'Together AI', base: 'https://api.together.xyz/v1' },
  mistral: { label: 'Mistral', base: 'https://api.mistral.ai/v1' },
  deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keylessList: true },
  vercel: { label: 'Vercel AI Gateway (Jev lives here)', base: 'https://ai-gateway.vercel.sh/v1', keylessList: true },
} satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof PROVIDERS;
export const isProviderId = (id: string): id is ProviderId => id in PROVIDERS;

/** A key saved locally in `.env.local`, e.g. OPENAI_API_KEY, so the UI field can stay blank. */
export const envKey = (id: ProviderId): string => process.env[`${id.toUpperCase()}_API_KEY`] ?? '';

/** A borrowed key never reaches a log line, an error banner or a results file. */
const redact = (text: string, key: string) => (key ? text.replaceAll(key, '***') : text);

export interface ListedModel { id: string; name: string }

/** The provider's own catalog, live. Shapes differ: a bare array or {data}, id plus name or display_name. */
export async function listModels(provider: ProviderId, key: string): Promise<ListedModel[]> {
  const spec: ProviderSpec = PROVIDERS[provider];
  const auth = spec.listHeaders?.(key) ?? (key ? { authorization: `Bearer ${key}` } : {});
  const res = await fetch(`${spec.base}/models`, {
    headers: { accept: 'application/json', ...auth },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${redact(text, key).slice(0, 300)}`);
  const json: unknown = JSON.parse(text);
  const raw = Array.isArray(json) ? json : ((json as { data?: unknown[] }).data ?? []);
  return (raw as { id?: string; name?: string; display_name?: string }[])
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({
      id: spec.strip && m.id!.startsWith(spec.strip) ? m.id!.slice(spec.strip.length) : m.id!,
      name: m.name ?? m.display_name ?? '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * One chat call, in two shapes. The retry drops every optional knob a provider might reject —
 * json_schema, temperature, max_tokens — which is how one adapter covers ten APIs.
 * ponytail: retry-on-400 instead of a per-provider capability table; write the table if a
 * provider starts answering 400 for some other reason and this hides it.
 */
async function chatCompletion(
  spec: ProviderSpec,
  entry: ModelEntry,
  key: string,
  messages: { role: string; content: string }[],
  schema: object,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const call = (extra: object) =>
    fetch(`${spec.base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: entry.route, messages, ...extra }),
    });

  let res = await call({
    temperature: 0,
    max_tokens: entry.maxTokens,
    response_format: { type: 'json_schema', json_schema: { name: 'move', strict: true, schema } },
  });
  if (res.status === 400) res = await call({ max_completion_tokens: entry.maxTokens });

  const text = await res.text();
  if (!res.ok) throw new Error(`${entry.id} ${res.status}: ${redact(text, key).slice(0, 300)}`);
  return JSON.parse(text) as ChatResponse;
}

/** A model that ignored response_format still answers JSON — sometimes wrapped in prose or fences. */
const looseJson = (text: string): unknown =>
  safeJson(text) ?? safeJson(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

/** Any OpenAI-compatible provider, played on a key the caller supplied. */
export const openaiCompatAdapter = (entry: ModelEntry, key: string): Adapter => ({
  id: entry.id,
  paid: false, // the caller's own key is billed, so the server budget guard has nothing to charge
  streams: false,
  async decide({ state, cfg, mode, hints, signal }: DecideContext): Promise<Decision> {
    const spec: ProviderSpec = PROVIDERS[entry.provider as ProviderId];
    // $schema is not part of an OpenAI json_schema object, and strict mode rejects the extra key.
    const schema: Record<string, unknown> = { ...z.toJSONSchema(moveSchemaFor(state.dir)), additionalProperties: false };
    delete schema.$schema;
    const tRequestSent = now();
    const body = await chatCompletion(
      spec,
      entry,
      key,
      [
        { role: 'system', content: systemPrompt(mode) },
        { role: 'user', content: stateJson(state, cfg, mode, hints) },
      ],
      schema,
      signal,
    );
    const tResponseComplete = now();
    const raw = body.choices?.[0]?.message?.content ?? '';
    const u = body.usage ?? {};
    return {
      move: parseMove(looseJson(raw)),
      timing: { tRequestSent, tFirstToken: null, tResponseComplete },
      usage: toUsage({
        inputTokens: u.prompt_tokens,
        outputTokens: u.completion_tokens,
        totalTokens: u.total_tokens,
        outputTokenDetails: { reasoningTokens: u.completion_tokens_details?.reasoning_tokens },
      }),
      raw,
    };
  },
});
