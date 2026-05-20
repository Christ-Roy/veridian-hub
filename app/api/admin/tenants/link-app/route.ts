/**
 * POST /api/admin/tenants/link-app
 *
 * Lie un user Hub (par email) à un tenant existant côté app downstream.
 * Si le user Hub n'existe pas → 404 (l'appelant doit d'abord créer le user
 * via /api/admin/users/create — pas de création implicite ici pour éviter
 * les bugs silencieux où un typo email crée 2 users).
 *
 * Idempotent : si déjà lié, met à jour les champs sans toucher aux autres
 * apps déjà attachées au même Tenant.
 *
 * Auth : requireAdmin. Audit : 'admin.tenant.link'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { linkApp, type AppLinkApp } from '@/lib/admin/link-app';
import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  user_email: z.string().email(),
  app: z.enum(['cms', 'analytics', 'notifuse', 'prospection']),
  external_tenant_id: z.string().min(1),
  external_tenant_slug: z.string().min(1).max(120),
  tenant_name: z.string().min(1).max(255),
  plan: z.string().optional(),
  fallback_url: z.string().url().optional(),
  magic_link_capable: z.boolean().optional(),
  provisioning_source: z.string().max(120).optional(),
  notes: z.string().max(1000).optional(),
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

export async function POST(request: NextRequest) {
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
    return NextResponse.json(
      {
        error: 'user_not_found',
        message:
          "Le user Hub n'existe pas ou n'a pas de supabaseUserId. Appelez d'abord POST /api/admin/users/create.",
      },
      { status: 404 }
    );
  }

  const result = await linkApp(prisma, {
    userUuid: user.supabaseUserId,
    app: parsed.data.app as AppLinkApp,
    externalTenantId: parsed.data.external_tenant_id,
    externalTenantSlug: parsed.data.external_tenant_slug,
    tenantName: parsed.data.tenant_name,
    plan: parsed.data.plan,
    fallbackUrl: parsed.data.fallback_url,
    magicLinkCapable: parsed.data.magic_link_capable,
    provisioningSource: parsed.data.provisioning_source,
    notes: parsed.data.notes,
  });

  const actor = resolveActor(request.headers, authResult.sessionEmail);
  await writeAuditLog(prisma, {
    action: 'admin.tenant.link',
    actor,
    targetType: 'app_link',
    targetId: result.tenantId,
    payload: {
      user_email: email,
      app: parsed.data.app,
      external_tenant_id: parsed.data.external_tenant_id,
      external_tenant_slug: parsed.data.external_tenant_slug,
      created_new_tenant: result.created,
    },
  });

  return NextResponse.json({
    tenant_id: result.tenantId,
    user_id: result.userUuid,
    app: result.app,
    metadata_path: result.metadataPath,
    created: result.created,
  });
}
