import { experimental_evaluate, generateObject } from 'ai';
import { z } from 'zod';
import { moveSchema, stateJson, systemPrompt } from '@/lib/decide/prompt';
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
      schema: moveSchema,
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

const CRITERIA = {
  UP: 'Move the head one cell up (y - 1).',
  DOWN: 'Move the head one cell down (y + 1).',
  LEFT: 'Move the head one cell left (x - 1).',
  RIGHT: 'Move the head one cell right (x + 1).',
} as const;

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
        move: { type: 'choice', instructions: systemPrompt(mode), criteria: CRITERIA },
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
  prompt_eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

async function ollamaChat(entry: ModelEntry, system: string, user: string, signal: AbortSignal) {
  const response = await fetch(`${OLLAMA_HOST()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: entry.route,
      stream: false,
      think: false,
      keep_alive: '10m',
      format: z.toJSONSchema(moveSchema),
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
    await ollamaChat(entry, systemPrompt('deadline'), `{"grid":{"w":${cfg.w},"h":${cfg.h}},"warmup":true}`, signal);
  },
  async decide({ state, cfg, mode, hints, signal }: DecideContext): Promise<Decision> {
    const tRequestSent = now();
    const body = await ollamaChat(entry, systemPrompt(mode), stateJson(state, cfg, mode, hints), signal);
    const tResponseComplete = now();
    const raw = body.message?.content ?? '';
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
