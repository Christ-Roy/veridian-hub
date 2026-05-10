import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE /api/admin/delete-tenant
 * Body: { email: string, confirm: true }
 *
 * Soft-deletes tenant rows for the given email and removes the Auth.js user
 * (cascade clears Account/Session via Prisma FK onDelete).
 * Does NOT delete Twenty/Notifuse workspaces (those need manual cleanup).
 */
export async function DELETE(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  let body: { email?: string; confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { email, confirm } = body;
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }
  if (confirm !== true) {
    return NextResponse.json(
      { error: 'Set confirm: true to proceed (destructive action)' },
      { status: 400 },
    );
  }

  // Find user (Auth.js)
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true },
  });
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }

  const userUuid = user.supabaseUserId;
  const actions: string[] = [];

  // Soft-delete tenants (only if we have a UUID bridge)
  if (userUuid) {
    const tenants = await prisma.tenant.findMany({
      where: { userId: userUuid },
      select: { id: true, twentyWorkspaceId: true, notifuseWorkspaceSlug: true },
    });

    for (const tenant of tenants) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { status: 'deleted', deletedAt: new Date() },
      });
      actions.push(`Soft-deleted tenant ${tenant.id}`);

      if (tenant.twentyWorkspaceId) {
        actions.push(
          `⚠️ Twenty workspace ${tenant.twentyWorkspaceId} still exists (manual cleanup needed)`,
        );
      }
      if (tenant.notifuseWorkspaceSlug) {
        actions.push(
          `⚠️ Notifuse workspace ${tenant.notifuseWorkspaceSlug} still exists (manual cleanup needed)`,
        );
      }
    }
    if (tenants.length === 0) {
      actions.push('No tenant row found');
    }

    // Delete subscriptions linked to this UUID
    const subResult = await prisma.subscription.deleteMany({ where: { userId: userUuid } });
    if (subResult.count) actions.push(`Deleted ${subResult.count} subscription(s)`);

    // Delete profile if any
    try {
      await prisma.profile.delete({ where: { id: userUuid } });
      actions.push('Deleted profile');
    } catch {
      /* profile not found — ignore */
    }
  } else {
    actions.push('User has no supabaseUserId bridge — skipped tenant/sub/profile cleanup');
  }

  // Finally remove the Auth.js user (cascades to Account, Session, MfaCode)
  try {
    await prisma.user.delete({ where: { id: user.id } });
    actions.push('Deleted auth user');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    actions.push(`⚠️ Auth user delete failed: ${message}`);
  }

  return NextResponse.json({
    ok: true,
    email,
    user_id: userUuid ?? user.id,
    actions,
  });
}
