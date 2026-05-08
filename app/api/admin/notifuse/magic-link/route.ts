import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
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

  if (!tenant.notifuseApiKey || !tenant.notifuseUserEmail) {
    return NextResponse.json(
      { error: 'Tenant Notifuse workspace not provisioned' },
      { status: 409 },
    );
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

  try {
    const result = await client.generateMagicLink({
      apiKey: tenant.notifuseApiKey,
      userEmail: tenant.notifuseUserEmail,
    });
    // Préférer auto_login_url (auto-connect via localStorage, sans saisie code).
    // Fallback magic_link garde l'ancien flow si le frontend a besoin de le tester.
    return NextResponse.json({
      autoLoginUrl: result.auto_login_url,
      magicLink: result.magic_link,
      expiresAt: result.expires_at,
    });
  } catch (err) {
    if (err instanceof NotifuseError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code >= 400 && err.code < 600 ? err.code : 502 },
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
