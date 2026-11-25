/** POST (bouton de /auth/adresse) : l'ancienne adresse annule le changement (AD-M3). Le jeton est la preuve, aucune session n'est demandée ni ouverte. */
import { NextResponse, type NextRequest } from 'next/server';

import { annuler } from '@/lib/adresses/annulation';
import { ipClient } from '@/lib/auth/ip-client';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 10, windowMs: 60_000, name: 'adresse-annuler' });

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (!debit.enforce(ipClient(request.headers)).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  const jeton = (await request.formData().catch(() => null))?.get('token');
  const r = await annuler(prisma, jeton);
  const res = NextResponse.redirect(new URL(`/auth/adresse?result=${'refus' in r ? r.refus : 'rendue'}`, base), 303);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}
