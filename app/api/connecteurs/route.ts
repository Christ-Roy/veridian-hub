/**
 * POST (formulaire de /dashboard/connexions) : brancher un service extérieur (vers son écran de consentement), ou le couper. Seulement depuis le Hub, par la
 * personne elle-même : preuve récente, jamais une session d'emprunt ni celle qu'un fournisseur d'organisation a ouverte.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { couper } from '@/lib/connecteurs/coffre';
import { CHEMIN_RETOUR_CONNECTEUR, COOKIE_CONNECTEUR, partir, TRANSACTION_CONNECTEUR_S } from '@/lib/connecteurs/oauth';
import { retourConnecteur } from '@/lib/connecteurs/porte';
import { connecteur } from '@/lib/connecteurs/registre';
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
  const vers = (avis: string) => NextResponse.redirect(new URL(`/dashboard/connexions?avis=${avis}`, base), 303);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const session = await auth();
  const user = await getCurrentUser();
  if (!user || !session?.user) return NextResponse.redirect(new URL('/login?callbackUrl=/dashboard/connexions', base), 303);
  if (isImpersonatedSession(session) || session.user.federe === true) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return NextResponse.redirect(new URL('/login?reauth=1&callbackUrl=/dashboard/connexions', base), 303);
  const f = await request.formData().catch(() => null);
  const c = connecteur(f?.get('connecteur'));
  if (!f || !c) return vers('refus');
  if (!debit.enforce(user.id).ok) return vers('trop');
  if (f.get('geste') === 'couper') {
    const r = await couper(prisma, userUuid(user), c.cle, retourConnecteur());
    return vers(r.coupee ? 'coupee' : 'absente');
  }
  if (f.get('geste') !== 'brancher') return vers('refus');
  try {
    const d = await partir(prisma, c, user.id, retourConnecteur());
    const r = NextResponse.redirect(d.url, 303);
    r.headers.set('Cache-Control', 'no-store');
    r.cookies.set(COOKIE_CONNECTEUR, d.cookie, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR_CONNECTEUR, maxAge: TRANSACTION_CONNECTEUR_S });
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'départ', connecteur: c.cle, error: err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}`.slice(0, 160) : 'erreur' }));
    return vers('injoignable');
  }
}
