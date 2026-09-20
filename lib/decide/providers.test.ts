import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame, defaultConfig } from '@/lib/game/engine';
import { ollamaAdapter } from '@/lib/decide/providers';
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
    expect(sent.request.format.properties.move.enum).toEqual(['UP', 'DOWN', 'LEFT', 'RIGHT']);

    expect(decision.move).toBe('UP');
    expect(decision.usage).toMatchObject({ input: 120, output: 4, estimated: false });
    expect(decision.timing.tFirstToken! - decision.timing.tRequestSent).toBe(3);
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
