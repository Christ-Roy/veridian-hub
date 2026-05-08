import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');
  if (adminSecret && headerSecret === adminSecret) return null;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isPlatformAdmin(session.user)) {
    return NextResponse.json({ error: 'Forbidden — admin access only' }, { status: 403 });
  }
  return null;
}

/**
 * POST /api/admin/impersonate
 * Body: { email: string }
 *
 * Generates auto-login URLs for all services for a given user.
 * Useful for debugging/support — login as any user without knowing their password.
 *
 * Hub login : on crée une Session Auth.js pour le user cible et on retourne
 * un lien `/auth/admin-impersonate?token=<sessionToken>` que le frontend doit
 * utiliser pour set le cookie côté client (cookie httpOnly cross-domain non
 * trivial à set depuis l'API). Pour l'instant on retourne juste le sessionToken
 * — un endpoint dédié `/api/auth/impersonate-set` peut le consommer (TODO LOT D).
 */
export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { email } = body;
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }

  // Get tenant (if user has UUID bridge)
  const tenant = user.supabaseUserId
    ? await prisma.tenant.findFirst({ where: { userId: user.supabaseUserId } })
    : null;

  // Generate Prospection auto-login token
  let prospectionUrl: string | null = null;
  const prospectionApiUrl = process.env.PROSPECTION_API_URL;
  const prospectionSecret = process.env.PROSPECTION_TENANT_API_SECRET;

  if (prospectionApiUrl && prospectionSecret) {
    try {
      const provRes = await fetch(`${prospectionApiUrl}/api/tenants/provision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${prospectionSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          name: email.split('@')[0],
          plan: tenant?.prospectionPlan || 'freemium',
        }),
      });
      if (provRes.ok) {
        const provData = await provRes.json();
        prospectionUrl = provData.login_url ?? null;

        if (provData.login_url && tenant) {
          const token = String(provData.login_url).split('t=')[1];
          await prisma.tenant.update({
            where: { id: tenant.id },
            data: {
              prospectionLoginToken: token ?? null,
              prospectionLoginTokenCreatedAt: new Date(),
              prospectionLoginTokenUsed: false,
            },
          });
        }
      }
    } catch {
      /* non-blocking */
    }
  }

  // Hub session : créer une vraie Session Auth.js pour le user cible.
  // Le sessionToken doit être posé côté client en cookie `authjs.session-token`
  // (ou `__Secure-authjs.session-token` en https). On le retourne brut + une
  // URL helper qui pointe vers un endpoint à créer (cf. TODO LOT D).
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires },
  });

  const hubUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.veridian.site';
  const hubLink = `${hubUrl}/api/auth/impersonate-callback?token=${encodeURIComponent(sessionToken)}`;

  return NextResponse.json({
    user_id: user.supabaseUserId ?? user.id,
    email,
    tenant_id: tenant?.id ?? null,
    links: {
      // TODO LOT D : implémenter /api/auth/impersonate-callback qui set le cookie
      // `authjs.session-token` (httpOnly, secure, sameSite=lax) avec ce token et
      // redirige vers /dashboard.
      hub: hubLink,
      prospection: prospectionUrl,
      twenty: tenant?.twentySubdomain ? `https://twenty.app.veridian.site` : null,
      notifuse: tenant?.notifuseWorkspaceSlug
        ? `https://notifuse.app.veridian.site`
        : null,
    },
    session: {
      token: sessionToken,
      expires: expires.toISOString(),
    },
  });
}
