import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { NotifuseClient } from '@/lib/notifuse/client';
import { resolveNotifuseAutoLogin } from '@/lib/notifuse/resolve-autologin';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { tenantId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tenantId = body.tenantId?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId required' }, { status: 400 });
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      userId: true,
      notifuseWorkspaceSlug: true,
      notifuseApiKey: true,
      notifuseUserEmail: true,
    },
  });

  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  // Resolve current user's UUID bridge to compare ownership
  const me = await prisma.user.findUnique({
    where: { id: sessionUser.id! },
    select: { supabaseUserId: true },
  });

  // Authorization: only the tenant owner OR a platform admin can request a magic link
  if (tenant.userId !== me?.supabaseUserId && !isPlatformAdmin(sessionUser)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl || !hubSecret) {
    return NextResponse.json(
      { error: 'Notifuse client not configured (NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET)' },
      { status: 500 },
    );
  }

  const client = new NotifuseClient({ apiUrl, hubSecret });

  // La résolution de l'URL d'auto-login vit dans `lib/notifuse/resolve-autologin.ts`.
  // Elle gère les deux chemins (clé API tenant, sinon réparation HMAC via
  // provision idempotent) — c'est ce qui débloque les tenants rattachés par
  // `hub link`, qui n'ont ni `notifuseApiKey` ni `notifuseUserEmail` en base.
  const result = await resolveNotifuseAutoLogin(tenant, { prisma, client });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, reason: result.reason },
      { status: result.status },
    );
  }

  // Préférer auto_login_url (auto-connect via localStorage, sans saisie code).
  // Fallback magic_link garde l'ancien flow si le frontend a besoin de le tester.
  return NextResponse.json({
    autoLoginUrl: result.autoLoginUrl,
    magicLink: result.magicLink,
    expiresAt: result.expiresAt,
    source: result.source,
  });
}
