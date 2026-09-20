import { greedyAdapter, mockAdapter, randomAdapter, type Adapter, type MockOptions } from '@/lib/decide/adapters';
import { gatewayAdapter, jevAdapter, ollamaAdapter } from '@/lib/decide/providers';

export interface ModelEntry {
  /** What you type on the CLI. */
  id: string;
  /** What is actually called: a Gateway model id, an Ollama tag, or a built-in name. */
  route: string;
  provider: 'mock' | 'baseline' | 'gateway' | 'jev' | 'ollama';
  /** Requested reasoning setting. Never silently changed — a refusal is logged per model. */
  reasoning: string;
  timeoutMs: number;
  maxTokens: number;
  enabled: boolean;
  paid: boolean;
  mock?: Partial<MockOptions>;
  note?: string;
}

/** Local tags from `ollama list`. Free, but only as fast as this machine is on the day. */
const ollama = (tag: string, route = tag, note?: string): ModelEntry => ({
  id: `ollama:${tag}`, route, provider: 'ollama',
  reasoning: 'none', timeoutMs: 120_000, maxTokens: 32, enabled: true, paid: false, note,
});

const OLLAMA: ModelEntry[] = [
  ollama('llama3.2:3b-instruct-q4_K_M'),
  ollama('llama3.2:3b-instruct-q8_0'),
  ollama('granite4:7b-a1b-h'),
  ollama('qwen2.5-coder:7b-instruct-q4_K_M'),
  ollama('mistral:7b-instruct-v0.3-q4_K_M'),
  ollama('llama3.1:8b-instruct-q4_K_M'),
  ollama('llama3.1:8b-instruct-q8_0'),
  {
    ...ollama('deepseek-r1:8b-llama-distill-q4_K_M'),
    maxTokens: 4096,
    enabled: false,
    note: 'distilled reasoner: Ollama 0.34 ignores think=false for this tag, so every move starts with a think block of 1k-4k+ tokens and the JSON never arrives. Even at 4096 tokens it answered 1 move in 5 (11.8s each) and every other record was done_reason=length. Flip enabled to re-measure that.',
  },
  ollama('gemma4:12b-it-q4_K_M'),
  ollama('phi4:14b-q4_K_M'),
  ollama('qwen3:14b-q4_K_M', undefined, 'hybrid reasoner: asked to think=false'),
  ollama('gemma4:26b-a4b-it-q4_K_M'),
  ollama('minicpm-v:latest', undefined, 'vision model, played on text only'),
  ollama('mistral-small-24b', 'hf.co/bartowski/Mistral-Small-24B-Instruct-2501-GGUF:IQ4_XS'),
  {
    ...ollama('nomic-embed-text:latest'),
    enabled: false,
    note: 'embeddings only: it has no /api/chat, so it cannot play',
  },
];

export const MODELS: ModelEntry[] = [
  {
    id: 'baseline:random', route: 'baseline:random', provider: 'baseline',
    reasoning: 'none', timeoutMs: 0, maxTokens: 0, enabled: true, paid: false,
  },
  {
    id: 'baseline:greedy-bfs', route: 'baseline:greedy-bfs', provider: 'baseline',
    reasoning: 'none', timeoutMs: 0, maxTokens: 0, enabled: true, paid: false,
  },
  {
    id: 'mock', route: 'mock', provider: 'mock',
    reasoning: 'none', timeoutMs: 30_000, maxTokens: 16, enabled: true, paid: false,
    mock: { latencyMs: 120 },
  },
  {
    id: 'mock:slow', route: 'mock', provider: 'mock',
    reasoning: 'none', timeoutMs: 30_000, maxTokens: 16, enabled: true, paid: false,
    mock: { latencyMs: 600, jitterMs: 2500, errorRate: 0.02, invalidRate: 0.03 },
    note: 'slow and jittery: drives the UI through timeouts, invalid replies and errors for free',
  },
  {
    id: 'gemini-3.8-flash', route: 'google/gemini-3.8-flash', provider: 'gateway',
    reasoning: 'low', timeoutMs: 30_000, maxTokens: 16, enabled: false, paid: true,
    note: 'the Gateway catalog offers effort low|medium|high for this model: "low" is its floor, not "off"',
  },
  {
    id: 'jev', route: 'typesafe-ai/jev', provider: 'jev',
    reasoning: 'none', timeoutMs: 30_000, maxTokens: 16, enabled: false, paid: true,
  },
  ...OLLAMA,
];

export const findModel = (id: string): ModelEntry => {
  const entry = MODELS.find((m) => m.id === id);
  if (!entry) throw new Error(`unknown model "${id}". Known: ${MODELS.map((m) => m.id).join(', ')}`);
  if (!entry.enabled) throw new Error(`model "${id}" is disabled in models.config.ts`);
  return entry;
};

export function createAdapter(entry: ModelEntry, seed: number): Adapter {
  switch (entry.provider) {
    case 'baseline':
      return entry.route === 'baseline:random' ? randomAdapter(seed) : greedyAdapter();
    case 'mock':
      return mockAdapter(entry.id, { seed, ...entry.mock });
    case 'gateway':
      return gatewayAdapter(entry);
    case 'jev':
      return jevAdapter(entry);
    case 'ollama':
      return ollamaAdapter(entry);
  }
}
