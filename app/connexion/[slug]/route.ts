/** GET /connexion/<organisation> : la porte d'entrée d'une organisation qui a son fournisseur d'identité. Sans fournisseur, inconnue ou fermée : la connexion habituelle, même réponse (M8). */
import { NextResponse, type NextRequest } from 'next/server';

import { ipClient } from '@/lib/auth/ip-client';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { idpPret } from '@/lib/federation/idp';
import { CHEMIN_RETOUR, COOKIE_FEDERATION, demarrer, TRANSACTION_S } from '@/lib/federation/oidc';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 30, windowMs: 60_000, name: 'federation' });

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const base = getHubBaseUrl(request.url);
  const habituelle = () => NextResponse.redirect(new URL('/login', base), 303);
  if (!debit.enforce(ipClient(request.headers)).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return habituelle();
  try {
    const i = await idpPret(prisma, { slug });
    if (!i) return habituelle();
    const d = await demarrer(i, new URL(CHEMIN_RETOUR, base).href);
    const r = NextResponse.redirect(d.url, 303);
    r.headers.set('Cache-Control', 'no-store');
    r.cookies.set(COOKIE_FEDERATION, d.cookie, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR, maxAge: TRANSACTION_S });
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[federation]', level: 'error', msg: 'fournisseur injoignable', slug, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
    return NextResponse.redirect(new URL('/auth/federation?code=fournisseur_injoignable', base), 303);
  }
}
