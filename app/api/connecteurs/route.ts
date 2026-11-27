/**
 * POST (formulaire de /dashboard/connexions) : brancher un service extérieur (vers son écran de consentement), le couper, y allumer ou éteindre l'écriture, ou
 * trancher un rebranchement. Seulement depuis le Hub, par la personne elle-même : preuve récente, jamais une session d'emprunt ni d'organisation.
 * Fermé (`CONNECTEURS_OUVERTS`) : seuls les gestes qui RETIRENT un accès restent.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { couper, reglerEcriture, trancher } from '@/lib/connecteurs/coffre';
import { CHEMIN_RETOUR_CONNECTEUR, COOKIE_CONNECTEUR, partir, TRANSACTION_CONNECTEUR_S } from '@/lib/connecteurs/oauth';
import { retourConnecteur } from '@/lib/connecteurs/porte';
import { connecteur, connecteursOuverts } from '@/lib/connecteurs/registre';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 20, windowMs: 60 * 60_000, name: 'connecteurs' });

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (avis: string, service?: string) => NextResponse.redirect(new URL(`/dashboard/connexions?avis=${avis}${service ? `&service=${service}` : ''}`, base), 303);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const session = await auth();
  const user = await getCurrentUser();
  if (!user || !session?.user) return NextResponse.redirect(new URL('/login?callbackUrl=/dashboard/connexions', base), 303);
  if (isImpersonatedSession(session) || session.user.federe === true) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return NextResponse.redirect(new URL('/login?reauth=1&callbackUrl=/dashboard/connexions', base), 303);
  const f = await request.formData().catch(() => null);
  const c = connecteur(f?.get('connecteur'));
  if (!f || !c) return vers('refus');
  if (!(await debit.enforce(user.id)).ok) return vers('trop');
  const moi = userUuid(user);
  const retour = retourConnecteur();
  const geste = f.get('geste');
  if (geste === 'couper') {
    const r = await couper(prisma, moi, c.cle, retour);
    return vers(!r.coupee ? 'absente' : r.revoquee ? 'coupee' : 'coupee_ici', c.cle);
  }
  if (geste === 'eteindre') return vers((await reglerEcriture(prisma, moi, c, false)) ? 'lecture' : 'absente');
  if (geste === 'garder') {
    const r = await trancher(prisma, moi, c.cle, 'garder', retour);
    return vers(!r.fait ? 'tranche' : r.revoquee ? 'garde' : 'garde_ici', c.cle);
  }
  if (geste !== 'brancher' && geste !== 'allumer' && geste !== 'remplacer') return vers('refus');
  // Avant tout départ : c'est lui qui inscrit notre client chez le service.
  if (!connecteursOuverts(moi)) return vers('ferme');
  if (geste === 'allumer') return vers((await reglerEcriture(prisma, moi, c, true)) ? 'ecriture' : 'refus');
  if (geste === 'remplacer') {
    const r = await trancher(prisma, moi, c.cle, 'remplacer', retour);
    return vers(!r.fait ? 'tranche' : r.revoquee ? 'remplace' : 'remplace_ici', c.cle);
  }
  try {
    const d = await partir(prisma, c, user.id, retour);
    const r = NextResponse.redirect(d.url, 303);
    r.headers.set('Cache-Control', 'no-store');
    r.cookies.set(COOKIE_CONNECTEUR, d.cookie, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR_CONNECTEUR, maxAge: TRANSACTION_CONNECTEUR_S });
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'départ', connecteur: c.cle, error: err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}`.slice(0, 160) : 'erreur' }));
    return vers('injoignable');
  }
}
