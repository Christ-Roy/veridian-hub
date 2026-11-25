/** POST (formulaire) { tenant } : l'organisation où les apps ouvriront. Seulement une dont on est membre, vivante (VER-252). */
import { NextResponse, type NextRequest } from 'next/server';

import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { COOKIE_ACTIF, organisationActive } from '@/lib/tenants/actif';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL('/login?callbackUrl=/dashboard/organisation', base), 303);
  const f = await request.formData().catch(() => null);
  const id = IdTenant.safeParse(f?.get('tenant'));
  const ok = id.success && (await organisationActive(prisma, userUuid(user), id.data)) === id.data;
  const res = NextResponse.redirect(new URL(`/dashboard/organisation?avis=${ok ? 'active' : 'refus'}`, base), 303);
  if (ok) res.cookies.set(COOKIE_ACTIF, id.data!, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: 31_536_000 });
  return res;
}
