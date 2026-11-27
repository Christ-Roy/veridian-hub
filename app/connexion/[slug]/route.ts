/** GET /connexion/<organisation> : la porte d'entrée d'une organisation qui a son fournisseur d'identité. Sans fournisseur, inconnue ou fermée : la connexion habituelle, même réponse (M8). */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { getCurrentUser } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { ipClient } from '@/lib/auth/ip-client';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { membreVivant } from '@/lib/adresses/federation';
import { partir } from '@/lib/federation/depart';
import { idpPret } from '@/lib/federation/idp';
import { dejaReliee } from '@/lib/federation/prouver';
import { COOKIE_SILENCE, pauserPorte, PAUSE_ESSAI_S, retenirSilence } from '@/lib/federation/porte';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 30, windowMs: 60_000, name: 'federation' });

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const base = getHubBaseUrl(request.url);
  const habituelle = () => NextResponse.redirect(new URL('/login', base), 303);
  if (!(await debit.enforce(ipClient(request.headers))).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return habituelle();
  try {
    const i = await idpPret(prisma, { slug });
    if (!i) return habituelle();
    // Déjà entrée par cette organisation, session vivante : pas de nouveau consentement.
    const session = await auth();
    if (session?.user?.federe === true && session.user.federeOrg === i.tenantId) return NextResponse.redirect(new URL('/dashboard', base), 303);
    // Connectée par ses propres moyens et membre : sa session reste la sienne, et gagne cette organisation.
    const u = session?.user && !isImpersonatedSession(session) && session.user.federe !== true ? await getCurrentUser() : null;
    const membre = u?.supabaseUserId ? await membreVivant(prisma, i.tenantId, u.supabaseUserId) : false;
    if (u && membre && !(await dejaReliee(prisma, i, u.id)) && !isAuthRecent(session!.user!.authAt, PREUVE_COMPTE_S)) return NextResponse.redirect(new URL(`/login?reauth=1&callbackUrl=${encodeURIComponent(`/connexion/${slug}`)}`, base), 303);
    // `?silence=1` (départ automatique de la page de connexion) : d'abord sans écran, une fois ; ce navigateur s'en souvient.
    const silence = request.nextUrl.searchParams.get('silence') === '1' && i.protocole !== 'saml' && !request.cookies.has(COOKIE_SILENCE);
    const d = await partir(i, base, { ...(u && membre && (await isEmailProvenForSession(u.id)) ? { prouver: { userId: u.id } } : {}), ...(silence ? { silence } : {}) });
    const r = NextResponse.redirect(d.url, 303);
    r.headers.set('Cache-Control', 'no-store');
    d.poser(r);
    pauserPorte(r, PAUSE_ESSAI_S, base.protocol === 'https:');
    if (silence) retenirSilence(r, base.protocol === 'https:');
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[federation]', level: 'error', msg: 'fournisseur injoignable', slug, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
    return NextResponse.redirect(new URL('/auth/federation?code=fournisseur_injoignable', base), 303);
  }
}
