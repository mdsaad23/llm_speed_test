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
  {
    id: 'ollama:qwen3:4b', route: 'qwen3:4b', provider: 'ollama',
    reasoning: 'none', timeoutMs: 120_000, maxTokens: 16, enabled: false, paid: false,
    note: 'example: enable once the tag is pulled (ollama pull qwen3:4b)',
  },
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
