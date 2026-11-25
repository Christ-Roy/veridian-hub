/**
 * Relier ou délier son identité d'organisation (VER-261). GET : les organisations qui ont un fournisseur. POST : relier (rend où aller) ou délier. Preuve
 * récente, jamais une session d'emprunt ni celle que le fournisseur a ouverte ; seulement depuis le Hub (une page étrangère relierait SON identité).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth/get-user';
import { denyIfImpersonated, denyUnlessRecentAuth, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { delier, fournisseurDe, liaisonsDe } from '@/lib/federation/liaison';
import { CHEMIN_RETOUR, COOKIE_FEDERATION, demarrer, TRANSACTION_S } from '@/lib/federation/oidc';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.strictObject({ geste: z.enum(['relier', 'delier']), tenant_id: z.string().uuid() });
const debit = new RateLimiter({ capacity: 20, windowMs: 60 * 60_000, name: 'federation-liaison' });
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

async function personne() {
  const u = await getCurrentUser();
  return u ? prisma.user.findUnique({ where: { id: u.id }, select: { id: true, email: true, emailVerified: true, supabaseUserId: true } }) : null;
}

export async function GET() {
  const u = await personne();
  return u ? rendre({ liaisons: await liaisonsDe(prisma, u) }) : rendre({ error: 'unauthorized' }, 401);
}

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (request.headers.get('origin') !== base.origin) return rendre({ error: 'origine_refusee' }, 403);
  const u = await personne();
  if (!u) return rendre({ error: 'unauthorized' }, 401);
  const refus = (await denyIfImpersonated()) ?? (await denyUnlessRecentAuth(PREUVE_COMPTE_S));
  if (refus) return refus;
  if (!u.emailVerified) return rendre({ error: 'email_not_verified' }, 403);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!c.success) return rendre({ error: 'invalid' }, 400);
  if (!debit.enforce(u.id).ok) return rendre({ error: 'rate_limited' }, 429);
  if (c.data.geste === 'delier') return (await delier(prisma, u, c.data.tenant_id)) ? rendre({ ok: true }) : rendre({ error: 'not_found' }, 404);
  const i = await fournisseurDe(prisma, u, c.data.tenant_id);
  if (!i) return rendre({ error: 'not_found' }, 404);
  try {
    const s = await demarrer(i, new URL(CHEMIN_RETOUR, base).href, undefined, undefined, { userId: u.id });
    const r = rendre({ ok: true, url: s.url });
    r.cookies.set(COOKIE_FEDERATION, s.cookie, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR, maxAge: TRANSACTION_S });
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[federation]', level: 'error', msg: 'fournisseur injoignable', idp: i.id, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
    return rendre({ error: 'fournisseur_injoignable' }, 503);
  }
}
