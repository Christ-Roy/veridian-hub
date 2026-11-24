/** POST /api/evenements/notifuse : `message.received` signé Standard Webhooks ; une vraie réponse humaine devient une tâche au CRM (VER-245, F3). */
import { NextResponse, type NextRequest } from 'next/server';

import { recevoirNotifuse } from '@/lib/evenements/notifuse';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const brut = await request.text();
  const r = brut.length > 16_000 ? { statut: 413, corps: { error: 'too_large' }, retryAfterS: undefined } : await recevoirNotifuse(prisma, request.headers, brut);
  return NextResponse.json(r.corps, { status: r.statut, headers: { 'Cache-Control': 'no-store', ...(r.retryAfterS ? { 'Retry-After': String(r.retryAfterS) } : {}) } });
}
