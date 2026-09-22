import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame, defaultConfig } from '@/lib/game/engine';
import { LAYA_INSTRUCTIONS, layaAdapter, ollamaAdapter, openaiCompatAdapter } from '@/lib/decide/providers';
import type { ModelEntry } from '@/lib/decide/models.config';

const entry = {
  id: 'ollama:test', route: 'test:4b', provider: 'ollama',
  reasoning: 'none', timeoutMs: 5000, maxTokens: 16, enabled: true, paid: false,
} as ModelEntry;

afterEach(() => vi.unstubAllGlobals());

/** Records the request body so the test can assert what Ollama was actually asked for. */
const stubFetch = (body: unknown) => {
  const sent: { request?: any } = {};
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.request = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return sent;
};

describe('ollama adapter', () => {
  it('asks for temperature 0, thinking off and a schema, and converts nanoseconds to ms', async () => {
    const sent = stubFetch({
      message: { content: '{"move":"UP"}' },
      prompt_eval_count: 120, eval_count: 4,
      load_duration: 1_000_000, prompt_eval_duration: 2_000_000, eval_duration: 5_000_000,
    });
    const cfg = defaultConfig({ w: 10, h: 10 });
    const decision = await ollamaAdapter(entry).decide({
      state: createGame(cfg), cfg, mode: 'deadline', hints: false,
      signal: new AbortController().signal,
    });

    expect(sent.request.options.temperature).toBe(0);
    expect(sent.request.think).toBe(false);
    expect(sent.request.stream).toBe(false);
    expect(sent.request.keep_alive).toBe('10m');
    // The snake starts facing RIGHT, so LEFT is never even offered as a token.
    expect(sent.request.format.properties.move.enum).toEqual(['UP', 'DOWN', 'RIGHT']);

    expect(decision.move).toBe('UP');
    expect(decision.usage).toMatchObject({ input: 120, output: 4, estimated: false });
    // Not toBe: both marks are performance.now() floats, so (t + 3) - t is only 3 to within epsilon.
    expect(decision.timing.tFirstToken! - decision.timing.tRequestSent).toBeCloseTo(3, 6);
  });

  it('treats unparseable content as an invalid answer rather than a crash', async () => {
    stubFetch({ message: { content: 'going up!' } });
    const cfg = defaultConfig({ w: 10, h: 10 });
    const decision = await ollamaAdapter(entry).decide({
      state: createGame(cfg), cfg, mode: 'deadline', hints: false,
      signal: new AbortController().signal,
    });
    expect(decision.move).toBeNull();
  });
});

const layaEntry = {
  id: 'laya', route: 'convaiinnovations/laya', provider: 'laya',
  reasoning: 'none', timeoutMs: 5000, maxTokens: 16, enabled: true, paid: false,
} as ModelEntry;

describe('laya adapter', () => {
  it('asks a single choice question over the legal moves and reads back choice + probabilities', async () => {
    const sent = stubFetch({
      answers: { move: { type: 'choice', choice: 'UP', probabilities: { UP: 0.7, DOWN: 0.2, RIGHT: 0.1 } } },
      usage: { input_tokens: 90, output_tokens: 0 },
    });
    const cfg = defaultConfig({ w: 10, h: 10 });
    const decision = await layaAdapter(layaEntry).decide({
      state: createGame(cfg), cfg, mode: 'deadline', hints: false,
      signal: new AbortController().signal,
    });

    // The snake starts facing RIGHT, so LEFT (the reversal) is never even offered.
    expect(Object.keys(sent.request.questions.move.criteria)).toEqual(['UP', 'DOWN', 'RIGHT']);
    // Laya truncates instructions past ~150 tokens and the state from the right.
    expect(sent.request.questions.move.instructions).toBe(LAYA_INSTRUCTIONS);
    expect(Object.keys(sent.request.state).slice(-2)).toEqual(['snake', 'obstacles']);
    expect(decision.move).toBe('UP');
    expect(decision.confidence).toBe(0.7);
    expect(decision.usage).toMatchObject({ input: 90, output: 0, estimated: false });
  });

  it('warmup resolves without spawning anything once the server is already up', async () => {
    // Not stubFetch: that helper assumes a JSON body to record, but /health is a bare GET.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
    await expect(layaAdapter(layaEntry).warmup?.(defaultConfig({ w: 10, h: 10 }))).resolves.toBeUndefined();
  });
});

const byok = {
  id: 'openrouter:acme/model-1', route: 'acme/model-1', provider: 'openrouter',
  reasoning: 'provider default', timeoutMs: 5000, maxTokens: 64, enabled: true, paid: false,
} as ModelEntry;

const chat = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 200, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } },
});

/** Replays the given HTTP statuses in order, recording every request that was sent. */
const stubChat = (replies: { status: number; body: unknown }[]) => {
  const sent: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return sent;
};

describe('openai-compatible adapter', () => {
  const play = (key = 'sk-secret') => {
    const cfg = defaultConfig({ w: 10, h: 10 });
    return openaiCompatAdapter(byok, key).decide({
      state: createGame(cfg), cfg, mode: 'deadline', hints: false,
      signal: new AbortController().signal,
    });
  };

  it('asks the provider for a strict move schema and reports the reasoning tokens it spent', async () => {
    const sent = stubChat([{ status: 200, body: chat('{"move":"UP"}') }]);
    const decision = await play();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0].body.temperature).toBe(0);
    expect(sent[0].body.max_tokens).toBe(64);
    expect(sent[0].body.response_format.json_schema.strict).toBe(true);
    expect(sent[0].body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(sent[0].body.response_format.json_schema.schema.properties.move.enum).toEqual(['UP', 'DOWN', 'RIGHT']);
    expect(decision.move).toBe('UP');
    expect(decision.usage).toMatchObject({ input: 200, output: 6, reasoning: 2, total: 206 });
  });

  it('retries once without the optional knobs when a provider rejects them', async () => {
    const sent = stubChat([
      { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'" } } },
      { status: 200, body: chat('here you go:\n```json\n{"move":"DOWN"}\n```') },
    ]);
    const decision = await play();

    expect(sent).toHaveLength(2);
    expect(sent[1].body.response_format).toBeUndefined();
    expect(sent[1].body.temperature).toBeUndefined();
    expect(sent[1].body.max_completion_tokens).toBe(64);
    // Fenced prose still carries a usable answer.
    expect(decision.move).toBe('DOWN');
  });

  it('never repeats the caller key back in an error', async () => {
    stubChat([{ status: 401, body: { error: { message: 'bad key sk-secret' } } }]);
    await expect(play()).rejects.toThrow(/\*\*\*/);
    await expect(play()).rejects.not.toThrow(/sk-secret/);
  });
});
