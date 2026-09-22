import { MODELS, runsHere } from '@/lib/decide/models.config';
import { PROVIDERS, envKey, isProviderId, listModels, type ProviderId } from '@/lib/decide/providers';

export const runtime = 'nodejs';

const PROVIDER_LIST = Object.entries(PROVIDERS).map(([id, p]) => ({
  id,
  label: p.label,
  keylessList: 'keylessList' in p,
  hasEnvKey: !!envKey(id as ProviderId),
}));

/**
 * No argument: what the server can run on its own — enabled and free. Paid server-side models
 * stay on the CLI, where the worst-case estimate and the typed confirmation live.
 * `?provider=`: that provider's live catalog, proxied because the browser cannot reach it
 * (CORS) and because the key belongs in a header, not in a third-party URL.
 */
export async function GET(req: Request) {
  const provider = new URL(req.url).searchParams.get('provider');
  if (!provider) {
    const local = MODELS.filter((m) => m.enabled && !m.paid && runsHere(m)).map((m) => ({ id: m.id, note: m.note ?? null }));
    return Response.json({ local, providers: PROVIDER_LIST });
  }
  if (!isProviderId(provider)) return Response.json({ error: `unknown provider "${provider}"` }, { status: 400 });

  const key = req.headers.get('x-provider-key') || envKey(provider);
  if (!key && !('keylessList' in PROVIDERS[provider])) {
    return Response.json({ error: `${PROVIDERS[provider].label} needs an API key to list its models` }, { status: 400 });
  }
  try {
    return Response.json(await listModels(provider, key));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
