/** POST (formulaire) : sortir de chez le client, redevenir soi (VER-263). Dans les apps ouvertes, la session du client reste jusqu'à ce qu'on y revienne : l'écran d'arrivée le dit. */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { isImpersonatedSession, secureCookiesEnabled, sessionCookieName } from '@/lib/auth/impersonation';
import { suiteEmprunt } from '@/lib/emprunt/journal';
import { CHEMIN_RETOUR, cookieRetour, lireRetour } from '@/lib/emprunt/retour';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { COOKIE_ACTIF } from '@/lib/tenants/actif';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const secure = secureCookiesEnabled();
  const session = await auth();
  const u = session?.user;
  const enEmprunt = isImpersonatedSession(session) && !!u?.empruntId && !!u.id;
  const retour = enEmprunt ? await lireRetour(request.cookies.get(cookieRetour(secure))?.value, u!.empruntId!) : null;

  // On revient sur la fiche du client quitté : l'app suivante est à un clic.
  const client = retour ? await prisma.user.findUnique({ where: { id: u!.id! }, select: { supabaseUserId: true } }).catch(() => null) : null;
  // Ni en emprunt, ni de quoi revenir : on ne touche pas à une session ordinaire, on ne rend rien à une session finie.
  const vers = retour ? `/dashboard/admin/clients?${client?.supabaseUserId ? `u=${client.supabaseUserId}&` : ''}sortie=${encodeURIComponent(u!.empruntId!)}` : u && !enEmprunt ? '/dashboard' : '/login?callbackUrl=%2Fdashboard%2Fadmin%2Fclients';
  const res = NextResponse.redirect(new URL(vers, base), 303);
  res.cookies.set(cookieRetour(secure), '', { httpOnly: true, secure, sameSite: 'strict', path: CHEMIN_RETOUR, maxAge: 0 });
  if (!enEmprunt) return res;
  await suiteEmprunt(prisma, { action: 'end', empruntId: u!.empruntId!, par: u!.impersonatedBy ?? '', userId: u!.id!, detail: { retour: !!retour } });
  if (retour) res.cookies.set(sessionCookieName(secure), retour.session, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 31_536_000 });
  // Un cookie `__Secure-` ne s'efface qu'avec `Secure` : `cookies.delete` le laissait vivant (vu le 26/11 par le sabotage emprunt-retour).
  else res.cookies.set(sessionCookieName(secure), '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 0 });
  if (retour?.org) res.cookies.set(COOKIE_ACTIF, retour.org, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 31_536_000 });
  else res.cookies.set(COOKIE_ACTIF, '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
