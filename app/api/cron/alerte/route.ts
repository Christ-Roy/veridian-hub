/**
 * POST /api/cron/alerte : le relais d'alerte des workflows GitHub du dépôt (27/11 : Grafana seule source, plus de Telegram). Un runner
 * hébergé par GitHub n'écrit pas dans Loki ; le Hub, si : il reçoit l'échec et écrit la ligne `flux=alerte` (`lib/notifications/alerte.ts`),
 * que la règle Grafana du Hub lit (`container="hub"`).
 * Garde : `Authorization: Bearer <CRON_SECRET>` (le même que les crons), comparé en temps constant. Forme stricte. Jamais `critique` :
 * un échec de CI ne touche pas un client par lui-même (impact `interne`). Le lien est celui d'un run du dépôt, rien d'autre.
 */
import { timingSafeEqual } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { construireAlerte } from '@/lib/notifications/alerte';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Corps = z
  .object({
    evenement: z.string().regex(/^ci\.[a-z0-9_.-]{1,60}$/),
    gravite: z.enum(['erreur', 'avertissement']),
    message: z.string().min(1).max(300),
    lien: z.string().regex(/^https:\/\/github\.com\/Christ-Roy\/veridian-hub\/actions\/runs\/\d{1,20}$/).optional(),
  })
  .strict();

function egal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron_not_configured' }, { status: 500 });
  const presente = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!presente || !egal(presente, secret)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let json: unknown = null;
  try {
    json = JSON.parse((await request.text()).trim() || 'null');
  } catch {
    json = null;
  }
  const lu = Corps.safeParse(json);
  if (!lu.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const ligne = construireAlerte({
    gravite: lu.data.gravite,
    impact: 'interne',
    evenement: lu.data.evenement,
    message: lu.data.message,
    detail: { origine: 'github-actions', lien: lu.data.lien },
  });
  console.log(JSON.stringify(ligne));
  return NextResponse.json({ emitted: true, gravite: ligne.gravite, evenement: ligne.evenement, dedup: ligne.dedup, ts: ligne.ts });
}
