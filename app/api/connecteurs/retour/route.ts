/** GET : retour du consentement d'un service extérieur. La transaction est dans le cookie scellé de CE navigateur ; seule la personne qui l'a ouverte finit. */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { garder } from '@/lib/connecteurs/coffre';
import { CHEMIN_RETOUR_CONNECTEUR, COOKIE_CONNECTEUR, ouvrirTransaction, terminer } from '@/lib/connecteurs/oauth';
import { retourConnecteur } from '@/lib/connecteurs/porte';
import { connecteursOuverts } from '@/lib/connecteurs/registre';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { denyIfImpersonated } from '@/lib/auth/recent-auth';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (avis: string) => {
    const r = NextResponse.redirect(new URL(`/dashboard/connexions?avis=${avis}`, base), 303);
    r.headers.set('Cache-Control', 'no-store');
    r.headers.set('Referrer-Policy', 'no-referrer');
    r.cookies.set(COOKIE_CONNECTEUR, '', { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR_CONNECTEUR, maxAge: 0 });
    return r;
  };
  const t = ouvrirTransaction(request.cookies.get(COOKIE_CONNECTEUR)?.value);
  if (!t) return vers('expiree');
  const user = await getCurrentUser();
  // Ouvert pour CETTE personne (CONNECTEURS_OUVERTS : tous, ou des hub_user_id nommés).
  if (!connecteursOuverts(user ? userUuid(user) : null)) return vers('ferme');
  // Un autre compte connecté entre-temps : la connexion n'est pas à lui.
  if (!user || user.id !== t.userId || (await denyIfImpersonated())) return vers('expiree');
  // La même personne, mais entre-temps par la connexion de son organisation : un service personnel ne se branche pas de là.
  if ((await auth())?.user?.federe === true) return vers('expiree');
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return vers('refusee');
  const retour = retourConnecteur();
  try {
    return vers(await garder(prisma, userUuid(user), t.cle, await terminer(prisma, t, new URL(`${retour}${url.search}`), retour), retour));
  } catch (err) {
    console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'retour', connecteur: t.cle, error: err instanceof Error ? `${err.name} ${(err as { code?: string }).code ?? ''}`.slice(0, 160) : 'erreur' }));
    return vers('echec');
  }
}
