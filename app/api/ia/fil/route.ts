/**
 * « Mon IA » : relit un fil rangé dans l'app (le Hub n'en garde rien). Menace 7 : la session doit être
 * celle de cet utilisateur, pour cette app et ce tenant, sinon rien n'est demandé à l'app.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { estAppFenetre, moteurActif, ouvrirSession } from '@/lib/ia/branchements';
import { contexteUtilisateur, espaceDe } from '@/lib/ia/contexte';
import { lireFil } from '@/lib/ia/fils';
import { refusSiCroisee } from '@/lib/ia/requete';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const croisee = refusSiCroisee(req);
  if (croisee) return croisee;
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  const app = req.nextUrl.searchParams.get('app');
  const sessionId = req.nextUrl.searchParams.get('session');
  if (!estAppFenetre(app) || !sessionId) return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  const q = req.nextUrl.searchParams;
  const espace = await espaceDe(c.hubUserId, q.get('tenant'), { app, workspaceId: null });
  if (!espace) return NextResponse.json({ error: 'espace_inconnu' }, { status: 404 });
  // La session est celle du moteur qui l'a ouverte (clé API ou abonnement), jamais une autre.
  const moteur = await moteurActif(prisma, c.hubUserId);
  const s = moteur ? await ouvrirSession(prisma, { hubUserId: c.hubUserId, app, tenantId: espace.id }, moteur, sessionId) : null;
  if (!s) return NextResponse.json({ error: 'session_inconnue' }, { status: 403 });
  const messages = await lireFil(app, { sessionId: s.id, hubUserId: c.hubUserId, tenantId: espace.id });
  return NextResponse.json({ messages: messages ?? [] });
}
