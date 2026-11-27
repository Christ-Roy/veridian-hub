/** POST /api/evenements/analytics/lot : les visites d'un contact connu par lots (CONTRAT-HUB §5.26), signées par Analytics, relayées au CRM. */
import { NextResponse, type NextRequest } from 'next/server';

import { recevoirVisites, VISITES_MAX_OCTETS } from '@/lib/evenements/visite';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const brut = await request.text();
  const r = brut.length > VISITES_MAX_OCTETS ? { statut: 413, corps: { error: 'too_large' } as Record<string, unknown>, retryAfterS: undefined } : await recevoirVisites(prisma, request.headers, brut);
  return NextResponse.json(r.corps, { status: r.statut, headers: { 'Cache-Control': 'no-store', ...(r.retryAfterS ? { 'Retry-After': String(r.retryAfterS) } : {}) } });
}
