/** POST /api/evenements/notifuse : `message.received` signé Standard Webhooks ; une vraie réponse humaine devient une tâche au CRM (VER-245, F3). */
import { NextResponse, type NextRequest } from 'next/server';

import { recevoirNotifuse, type Reception } from '@/lib/evenements/notifuse';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Notifuse coupe à 10 s et livre en file : au-delà, on rend 503 `en_cours` et le travail continue ici (serveur permanent, rien n'en dépend côté
 * source). Le réessai, même webhook-id, lit `deja_traite`, ou refait si le CRM a refusé (ligne libérée) ou si ce processus est tombé (reprise 3 min).
 */
const REPONDRE_AVANT_MS = 8_000;

export async function POST(request: NextRequest) {
  const brut = await request.text();
  let r: Reception;
  if (brut.length > 16_000) r = { statut: 413, corps: { error: 'too_large' } };
  else {
    const travail = recevoirNotifuse(prisma, request.headers, brut);
    let minuteur: NodeJS.Timeout | undefined;
    const tard = new Promise<'tard'>((ok) => { minuteur = setTimeout(() => ok('tard'), REPONDRE_AVANT_MS); });
    const premier = await Promise.race([travail, tard]).finally(() => clearTimeout(minuteur));
    if (premier === 'tard') {
      travail.then((x) => { if (x.statut >= 500) console.error('[evenements] notifuse, après la réponse :', x.statut, x.corps.error); }, (err) => console.error('[evenements] notifuse, après la réponse :', err instanceof Error ? err.message : 'erreur'));
      r = { statut: 503, corps: { error: 'en_cours' }, retryAfterS: 30 };
    } else r = premier;
  }
  return NextResponse.json(r.corps, { status: r.statut, headers: { 'Cache-Control': 'no-store', ...(r.retryAfterS ? { 'Retry-After': String(r.retryAfterS) } : {}) } });
}
