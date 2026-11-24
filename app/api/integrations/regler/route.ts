/**
 * POST (formulaire de /dashboard/liaisons) : allumer ou couper une liaison, sans IA. Même code et mêmes droits que
 * `hub.integrations_regler` : la première ouverture mène à la page de confirmation du propriétaire, la coupure est directe.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { reglerIntegration } from '@/lib/delegation/interrupteur';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ tenant: z.string().uuid(), paire: z.string().max(60), etat: z.enum(['allumee', 'eteinte']) });

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (chemin: string) => NextResponse.redirect(new URL(chemin, base), 303);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const session = await auth();
  const user = await getCurrentUser();
  if (!user || !session) return vers('/login?callbackUrl=/dashboard/liaisons');
  if (isImpersonatedSession(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const c = Corps.safeParse(form ? Object.fromEntries(form) : null);
  if (!c.success) return vers('/dashboard/liaisons?avis=refus');
  const r = await reglerIntegration(prisma, { tenantId: c.data.tenant, paire: c.data.paire, etat: c.data.etat, hubUserId: userUuid(user), client: 'Veridian, page Liaisons', origine: base.origin });
  if ('lien' in r) return vers(new URL(r.lien).pathname);
  return vers(`/dashboard/liaisons?avis=${'refus' in r ? r.refus : r.etat}`);
}
