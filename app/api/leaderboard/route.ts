import { readLeaderboard } from '@/lib/metrics/leaderboard';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return Response.json(await readLeaderboard());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
