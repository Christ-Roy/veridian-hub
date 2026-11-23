/** L'outil visé est-il déclaré en lecture seule ? Lu dans la porte, jamais dans ce que propose le modèle. */
import { NextResponse, type NextRequest } from 'next/server';

import { vientDeLAtelier } from '@/lib/ia/atelier';
import { appelantPourAtelier } from '@/lib/ia/atelier-appel';
import { approbationPour } from '@/lib/ia/moteur';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const brut = await req.text();
  if (!vientDeLAtelier(req.headers, brut)) return NextResponse.json({ error: 'signature' }, { status: 401 });
  const d = JSON.parse(brut) as { hubUserId?: string; tenantId?: string; sessionId?: string; nom?: string };
  const a = await appelantPourAtelier(d);
  if (!a) return NextResponse.json({ error: 'session_refusee' }, { status: 403 });
  return NextResponse.json({ lectureSeule: (await approbationPour(prisma, a.qui, String(d.nom ?? ''))) === 'not-applicable' });
}
