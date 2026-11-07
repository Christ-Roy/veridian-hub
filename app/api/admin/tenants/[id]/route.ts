// DELETE /api/admin/tenants/[id] : retire un tenant SANS utilisateur (restes de tests d'avril 2026).
//
// Body : { confirm: true }
//
// `delete-tenant` passe par l'email du compte : un tenant orphelin n'a aucun chemin. Celui-ci refuse
// (409) dès qu'un compte, un membre ou un abonnement y est rattaché, quel qu'il soit : pour ceux-là,
// `delete-tenant` et son push vers les apps restent le seul chemin. Soft-delete tracé dans l'audit.
//
// Auth : requireAdmin (session admin ou x-admin-secret).

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== true) {
    return NextResponse.json({ error: 'Set confirm: true to proceed' }, { status: 400 });
  }

  const { id } = await params;
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: { id: true, name: true, userId: true, status: true },
  });
  if (!tenant) return NextResponse.json({ error: 'tenant_not_found' }, { status: 404 });
  if (tenant.status === 'deleted') return NextResponse.json({ ok: true, already_deleted: true });

  const [user, members, subscriptions] = await Promise.all([
    prisma.user.findUnique({ where: { supabaseUserId: tenant.userId }, select: { id: true } }),
    prisma.tenantMember.count({ where: { tenantId: id, deletedAt: null } }),
    prisma.subscription.count({ where: { userId: tenant.userId } }),
  ]);
  if (user || members > 0 || subscriptions > 0) {
    return NextResponse.json(
      { error: 'tenant_not_orphan', has_user: Boolean(user), members, subscriptions },
      { status: 409 },
    );
  }

  await prisma.tenant.update({ where: { id }, data: { status: 'deleted', deletedAt: new Date() } });
  await writeAuditLog(prisma, {
    action: 'admin.tenant.delete_orphan',
    actor: resolveActor(request.headers, (await auth())?.user?.email),
    targetType: 'tenant',
    targetId: id,
    payload: { name: tenant.name },
  });
  return NextResponse.json({ ok: true, tenant_id: id, name: tenant.name });
}
