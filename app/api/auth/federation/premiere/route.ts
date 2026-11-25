/** POST (formulaires de /auth/premiere-entree) : demander le code, puis le confirmer. L'identité vient du fournisseur, scellée 15 min dans CE navigateur. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { ipClient } from '@/lib/auth/ip-client';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { ouvrirSession, sortieDe } from '@/lib/federation/conclure';
import { idpPret } from '@/lib/federation/idp';
import { confirmerPremiere, COOKIE_PREMIERE, demanderPremiere, ouvrirPremiere } from '@/lib/federation/premiere';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 20, windowMs: 10 * 60_000, name: 'premiere-ip' });
const Email = z.string().trim().max(254).email();

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  if (!debit.enforce(ipClient(request.headers)).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
  const page = (q: Record<string, string>) => {
    const u = new URL('/auth/premiere-entree', base);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    const r = NextResponse.redirect(u, 303);
    r.headers.set('Cache-Control', 'no-store');
    return r;
  };
  const s = sortieDe(base, { nom: COOKIE_PREMIERE, chemin: '/' });
  const p = ouvrirPremiere(request.cookies.get(COOKIE_PREMIERE)?.value);
  if (!p) return s.refus('demande_expiree');
  const i = await idpPret(prisma, { id: p.idp });
  // Seulement un fournisseur qui n'affirme aucune adresse : les autres ont leur règle.
  if (!i || i.domaines.length > 0) return s.refus('organisation_indisponible');
  const f = await request.formData().catch(() => null);
  const email = Email.safeParse(f?.get('email'));
  if (!f || !email.success) return page({ avis: 'adresse' });
  if (f.get('geste') === 'demander') {
    const r = await demanderPremiere(prisma, i, p, email.data);
    return r === 'trop' ? page({ avis: 'trop' }) : page({ etape: 'code', email: email.data });
  }
  const r = await confirmerPremiere(prisma, i, p, email.data, String(f.get('code') ?? '').trim());
  if ('refus' in r) {
    if (r.refus === 'code_faux' || r.refus === 'trop') return page({ etape: 'code', email: email.data, avis: r.refus });
    return s.refus(r.refus);
  }
  return ouvrirSession(request, base, i, r, s);
}
