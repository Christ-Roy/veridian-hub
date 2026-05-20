/**
 * DELETE /api/admin/tenants/unlink-app
 *
 * Inverse de link-app : retire l'app d'un Tenant Hub (soft unlink).
 * - Pour CMS/Analytics : retire la clé du JSON `metadata`
 * - Pour Notifuse/Prospection : reset les colonnes dédiées
 * - La row Tenant N'EST PAS supprimée même si plus aucune app n'y reste,
 *   pour préserver l'historique (audit + facturation).
 *
 * Auth : requireAdmin. Audit : 'admin.tenant.unlink'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { unlinkApp, type AppLinkApp } from '@/lib/admin/link-app';
import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  user_email: z.string().email(),
  app: z.enum(['cms', 'analytics', 'notifuse', 'prospection']),
  reason: z.string().max(500).optional(),
});

async function authenticate(request: NextRequest): Promise<
  | { ok: true; sessionEmail: string | null }
  | { ok: false; response: NextResponse }
> {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');
  if (adminSecret && headerSecret === adminSecret) {
    return { ok: true, sessionEmail: null };
  }
  const session = await auth();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    };
  }
  if (!isPlatformAdmin(session.user)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }
  return { ok: true, sessionEmail: session.user.email ?? null };
}

export async function DELETE(request: NextRequest) {
  const authResult = await authenticate(request);
  if (!authResult.ok) return authResult.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const email = parsed.data.user_email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true },
  });

  if (!user || !user.supabaseUserId) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const result = await unlinkApp(prisma, {
    userUuid: user.supabaseUserId,
    app: parsed.data.app as AppLinkApp,
  });

  if (!result.tenantId) {
    return NextResponse.json(
      { error: 'tenant_not_found', message: 'Ce user n\'a aucun Tenant à unlink.' },
      { status: 404 }
    );
  }

  const actor = resolveActor(request.headers, authResult.sessionEmail);
  await writeAuditLog(prisma, {
    action: 'admin.tenant.unlink',
    actor,
    targetType: 'app_link',
    targetId: result.tenantId,
    payload: {
      user_email: email,
      app: parsed.data.app,
      unlinked: result.unlinked,
      reason: parsed.data.reason,
    },
  });

  return NextResponse.json({
    tenant_id: result.tenantId,
    app: parsed.data.app,
    unlinked: result.unlinked,
  });
}
