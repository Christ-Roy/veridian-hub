/** POST (formulaire de /auth/organisation) { tenant } : passer par le fournisseur de CETTE organisation en gardant sa session (VER-261). */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { getCurrentUser } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { membreVivant } from '@/lib/adresses/federation';
import { partir } from '@/lib/federation/depart';
import { idpPret } from '@/lib/federation/idp';
import { COOKIE_SILENCE, retenirSilence } from '@/lib/federation/porte';
import { dejaReliee } from '@/lib/federation/prouver';
import { PAGE_ORGANISATION } from '@/lib/federation/session';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 20, windowMs: 10 * 60_000, name: 'federation-prouver' });

/** POST : le bouton, avec écran chez le fournisseur. */
export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  return aller(request, base, (await request.formData().catch(() => null))?.get('tenant'), false);
}

/**
 * GET ?tenant=&silence=1 : l'écran /auth/organisation y envoie seul une personne DÉJÀ reliée, une fois : essai sans écran (prompt=none). Rien ne s'y relie ;
 * la conclusion exige la même personne et son propre `sub`, donc une page étrangère qui y pousserait le navigateur n'y gagne rien.
 */
export async function GET(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const tenant = request.nextUrl.searchParams.get('tenant');
  if (request.nextUrl.searchParams.get('silence') !== '1' || request.cookies.has(COOKIE_SILENCE)) return NextResponse.redirect(new URL(`/auth/organisation${tenant ? `?org=${encodeURIComponent(tenant)}` : ''}`, base), 303);
  return aller(request, base, tenant, true);
}

async function aller(request: NextRequest, base: URL, tenantBrut: unknown, silence: boolean): Promise<NextResponse> {
  const vers = (chemin: string) => { const r = NextResponse.redirect(new URL(chemin, base), 303); r.headers.set('Cache-Control', 'no-store'); return r; };
  const session = await auth();
  const user = await getCurrentUser();
  if (!user?.supabaseUserId || !session?.user) return vers(`/login?callbackUrl=${PAGE_ORGANISATION}`);
  // Une session d'emprunt ne prouve personne ; une session fédérée n'a qu'une organisation, la sienne.
  if (isImpersonatedSession(session) || session.user.federe === true) return vers('/auth/federation?code=session_refusee');
  if (!(await debit.enforce(user.id)).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
  const id = IdTenant.safeParse(tenantBrut);
  if (!id.success || !(await membreVivant(prisma, id.data, user.supabaseUserId))) return vers('/auth/federation?code=non_attendu');
  const l = await prisma.tenantIdp.findUnique({ where: { tenantId: id.data }, select: { id: true } });
  const i = l ? await idpPret(prisma, { id: l.id }) : null;
  if (!i) return vers('/auth/federation?code=organisation_indisponible');
  const reliee = await dejaReliee(prisma, i, user.id);
  // Sans écran : seulement une identité déjà reliée, en OIDC ; sinon le bouton.
  if (silence && (!reliee || i.protocole === 'saml')) return vers(`/auth/organisation?org=${id.data}&silence=sans`);
  // Première fois : il faut être sûr que c'est elle, pas quelqu'un devant son écran ouvert.
  if (!reliee && !isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return vers(`/login?reauth=1&callbackUrl=${PAGE_ORGANISATION}`);
  if (!(await isEmailProvenForSession(user.id))) return vers('/auth/federation?code=email_not_verified');
  try {
    const d = await partir(i, base, { prouver: { userId: user.id }, ...(silence ? { silence } : {}) });
    const r = NextResponse.redirect(d.url, 303);
    r.headers.set('Cache-Control', 'no-store');
    d.poser(r);
    if (silence) retenirSilence(r, base.protocol === 'https:');
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[federation]', level: 'error', msg: 'fournisseur injoignable', idp: i.id, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
    return vers('/auth/federation?code=fournisseur_injoignable');
  }
}
