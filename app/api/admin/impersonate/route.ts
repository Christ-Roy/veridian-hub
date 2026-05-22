import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { prisma } from '@/lib/prisma';
import { createProspectionClientFromEnv } from '@/lib/prospection/client';
import {
  createImpersonationToken,
  isImpersonatedSession,
} from '@/lib/auth/impersonation';
import { getURL } from '@/utils/helpers';

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
  // Anti-ré-impersonation : un user déjà impersoné ne peut pas relancer une
  // impersonation, même si son email figure dans la whitelist admin.
  if (isImpersonatedSession(session)) {
    return NextResponse.json(
      { error: 'Forbidden — impersonated session cannot impersonate' },
      { status: 403 },
    );
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
 * Hub login : on génère un **token impersonate court-vécu** (10 min, usage
 * unique, stocké hashé — cf. lib/auth/impersonation.ts) et on retourne le
 * lien `/api/auth/impersonate-callback?token=<rawToken>`. Ouvrir ce lien
 * dans le navigateur consomme le token et pose le cookie de session Auth.js
 * du user cible (JWT marqué `impersonated`). Le volet session est aussi
 * disponible isolément via POST /api/auth/impersonate-set.
 *
 * NB : la stratégie de session du Hub est `jwt` — créer une row dans la
 * table `sessions` ne produit AUCUNE session valide (Auth.js ne la lit
 * jamais en mode JWT). C'est pourquoi on passe par un JWT encodé.
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
  const prospectionClient = createProspectionClientFromEnv();
  const targetUserUuid = user.supabaseUserId ?? user.id;

  if (prospectionClient) {
    try {
      const provData = await prospectionClient.provisionTenant({
        email,
        name: email.split('@')[0],
        userId: targetUserUuid,
        plan: tenant?.prospectionPlan || 'freemium',
      });
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
    } catch {
      /* non-blocking */
    }
  }

  // Hub session : génère un token impersonate court-vécu (10 min, usage
  // unique, stocké hashé). Le lien `impersonate-callback` consomme ce token
  // et pose le cookie de session Auth.js du user cible.
  const { rawToken, expires } = await createImpersonationToken(prisma, user.id);
  const hubLink = `${getURL('/api/auth/impersonate-callback')}?token=${encodeURIComponent(rawToken)}`;

  // Audit — qui a déclenché l'impersonation de qui (via la route admin).
  const session = await auth();
  const actor = session?.user?.email
    ? `admin:${session.user.email}`
    : 'token:ADMIN_SECRET';
  await writeAuditLog(prisma, {
    action: 'admin.impersonate.start',
    actor,
    targetType: 'user',
    targetId: user.id,
    payload: { targetEmail: user.email, expiresAt: expires.toISOString(), via: 'admin.impersonate' },
  });

  return NextResponse.json({
    user_id: user.supabaseUserId ?? user.id,
    email,
    tenant_id: tenant?.id ?? null,
    links: {
      // Ouvrir ce lien dans le navigateur consomme le token impersonate et
      // pose le cookie de session Auth.js (httpOnly, secure, sameSite=lax),
      // puis redirige vers /dashboard.
      hub: hubLink,
      prospection: prospectionUrl,
      notifuse: tenant?.notifuseWorkspaceSlug
        ? `https://notifuse.app.veridian.site`
        : null,
    },
    session: {
      // Token impersonate brut (usage unique, expire vite) — fourni pour
      // les usages programmatiques. Pas un cookie de session.
      token: rawToken,
      expires: expires.toISOString(),
    },
  });
}
