import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { denyUnlessEmailProven } from '@/lib/auth/email-proof';
import { sessionAdmin } from '@/lib/admin/session-admin';
import { lienApp } from '@/lib/apps/lien-app';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (sessionUser.id && sessionUser.email) {
    const denied = await denyUnlessEmailProven({ id: sessionUser.id, email: sessionUser.email });
    if (denied) return denied;
  } else {
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

  // Authorization: only the tenant owner OR a platform admin can open Mail
  if (tenant.userId !== me?.supabaseUserId && !(await sessionAdmin()).ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!tenant.notifuseWorkspaceSlug) {
    return NextResponse.json(
      { error: "Aucun workspace Notifuse n'est rattaché à ce compte.", reason: 'not_linked' },
      { status: 409 },
    );
  }

  const url = lienApp('notifuse');
  if (!url) {
    return NextResponse.json({ error: 'Mail non branché (NOTIFUSE_API_URL)' }, { status: 500 });
  }

  return NextResponse.json({ url });
}
