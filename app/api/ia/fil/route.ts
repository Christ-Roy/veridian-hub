/**
 * « Mon IA » : relit un fil rangé dans l'app (le Hub n'en garde rien). Menace 7 : la session doit être
 * celle de cet utilisateur, pour cette app et ce tenant, sinon rien n'est demandé à l'app.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { estAppChat, ouvrirSession } from '@/lib/ia/branchements';
import { contexteUtilisateur, espaceDe } from '@/lib/ia/contexte';
import { lireFil } from '@/lib/ia/fils';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  const app = req.nextUrl.searchParams.get('app');
  const sessionId = req.nextUrl.searchParams.get('session');
  if (!estAppChat(app) || !sessionId) return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  const espace = await espaceDe(c.hubUserId, req.nextUrl.searchParams.get('tenant'));
  if (!espace) return NextResponse.json({ error: 'espace_inconnu' }, { status: 404 });
  const s = await ouvrirSession(prisma, { hubUserId: c.hubUserId, app, tenantId: espace.id }, 'cle-api', sessionId);
  if (!s) return NextResponse.json({ error: 'session_inconnue' }, { status: 403 });
  const messages = await lireFil(app, { sessionId: s.id, hubUserId: c.hubUserId, tenantId: espace.id });
  return NextResponse.json({ messages: messages ?? [] });
}
