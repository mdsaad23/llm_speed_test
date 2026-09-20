import { readFileSync } from 'node:fs';
import type { Price } from '@/lib/metrics/metrics';
import type { ModelEntry } from '@/lib/decide/models.config';

const TABLE: Record<string, Price> = JSON.parse(
  readFileSync(new URL('./pricing.json', import.meta.url), 'utf8'),
);

export const priceFor = (route: string): Price | null => TABLE[route] ?? null;

/** A paid model with no verified price never runs. Local and free models price at zero. */
export function requirePrice(entry: ModelEntry): Price | null {
  if (!entry.paid) return null;
  const price = priceFor(entry.route);
  if (!price) {
    throw new Error(
      `no verified price for "${entry.route}" — refusing to run it. Add it to lib/decide/pricing.json with source_url and verified_at.`,
    );
  }
  return price;
}
