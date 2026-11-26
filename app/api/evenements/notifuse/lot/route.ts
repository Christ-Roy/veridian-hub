/** POST /api/evenements/notifuse/lot : l'activité Mail par lots (CONTRAT-HUB §5.25), signée par l'espace, relayée au CRM (`app_evenements_mail`). */
import { NextResponse, type NextRequest } from 'next/server';

import { LOT_MAX_OCTETS, recevoirLot } from '@/lib/evenements/lot';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const brut = await request.text();
  const r = brut.length > LOT_MAX_OCTETS ? { statut: 413, corps: { error: 'too_large' } as Record<string, unknown>, retryAfterS: undefined } : await recevoirLot(prisma, request.headers, brut);
  return NextResponse.json(r.corps, { status: r.statut, headers: { 'Cache-Control': 'no-store', ...(r.retryAfterS ? { 'Retry-After': String(r.retryAfterS) } : {}) } });
}
