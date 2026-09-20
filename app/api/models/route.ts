import { MODELS } from '@/lib/decide/models.config';

export const runtime = 'nodejs';

/** What the browser is allowed to offer: enabled and free. Paid models stay on the CLI. */
export function GET() {
  const free = MODELS.filter((m) => m.enabled && !m.paid).map((m) => ({ id: m.id, note: m.note ?? null }));
  return Response.json(free);
}
