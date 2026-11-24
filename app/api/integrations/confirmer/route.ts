/** POST (formulaire de /liaisons/confirmer/<jeton>) : le clic du propriétaire. Session récente, jamais une session d'emprunt. */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { confirmerDemande } from '@/lib/delegation/interrupteur';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (chemin: string) => NextResponse.redirect(new URL(chemin, base), 303);
  // Le cookie de session est SameSite=Lax ; l'origine est contrôlée en plus : un autre site n'allume rien.
  const origine = request.headers.get('origin');
  if (origine !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const jeton = String(form?.get('jeton') ?? '');
  const session = await auth();
  const user = await getCurrentUser();
  if (!user || !session) return vers(`/login?callbackUrl=${encodeURIComponent(`/liaisons/confirmer/${jeton}`)}`);
  if (isImpersonatedSession(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return vers('/liaisons/confirmer/ancienne');
  const r = await confirmerDemande(prisma, jeton, userUuid(user));
  return vers(`/liaisons/confirmer/${r.ok ? 'fait' : 'refus'}`);
}
