/**
 * POST /api/admin/tenants/app-access
 *
 * Active ou désactive une app GATED (twenty/CRM, analytics, cms) pour un
 * tenant. Outil d'admin SaaS : Robert pilote l'accès aux services pas-encore-
 * grand-public, par tenant. Défaut OFF (sans activation explicite, la card
 * reste éteinte sur le dashboard).
 *
 * Prospection + Notifuse ne sont PAS gérés ici (toujours grand public).
 *
 * Auth : authenticateAdmin (HUB_ADMIN_SECRET ou session admin).
 * Audit : 'admin.tenant.app_access'.
 *
 * Body :
 *   { user_email: string, app: 'twenty'|'analytics'|'cms', enabled: boolean }
 *
 * Idempotent : ré-appeler avec le même `enabled` ne change rien (upsert).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';
import {
  GATED_APP_KEYS,
  setTenantAppEnabled,
  type GatedAppKey,
} from '@/lib/tenant-apps';
import { ensureCrmWorkspace } from '@/lib/crm/provision';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  user_email: z.string().email(),
  app: z.enum(GATED_APP_KEYS),
  enabled: z.boolean(),
});

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const email = parsed.data.user_email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true, emailVerified: true, name: true },
  });

  if (!user || !user.supabaseUserId) {
    return NextResponse.json(
      {
        error: 'user_not_found',
        message:
          "Le user Hub n'existe pas ou n'a pas de supabaseUserId (UUID bridge).",
      },
      { status: 404 },
    );
  }

  // Le CRM a un espace par utilisateur, créé ici et nulle part ailleurs (§3.8) : pas d'activation sans espace.
  let crmWorkspaceId: string | undefined;
  if (parsed.data.app === 'twenty' && parsed.data.enabled) {
    if (!user.emailVerified) {
      return NextResponse.json(
        { error: 'email_not_proven', message: "L'adresse n'est pas prouvée : aucun espace CRM n'est créé." },
        { status: 409 },
      );
    }
    const provision = await ensureCrmWorkspace(
      prisma,
      { hubUserId: user.supabaseUserId, email, name: user.name },
      { actorEmail: resolveActor(request.headers, authResult.sessionEmail) },
    );
    if (!provision.ok) {
      return NextResponse.json(
        { error: provision.error === 'tenant_not_found' ? 'tenant_not_found' : 'crm_provision_failed', detail: provision.error },
        { status: provision.error === 'tenant_not_found' ? 404 : provision.error === 'crm_not_configured' ? 503 : 502 },
      );
    }
    crmWorkspaceId = provision.workspaceId;
  }

  const result = await setTenantAppEnabled(prisma, {
    userUuid: user.supabaseUserId,
    appKey: parsed.data.app as GatedAppKey,
    enabled: parsed.data.enabled,
    actorEmail: resolveActor(request.headers, authResult.sessionEmail),
  });

  const actor = resolveActor(request.headers, authResult.sessionEmail);
  await writeAuditLog(prisma, {
    action: 'admin.tenant.app_access',
    actor,
    targetType: 'tenant_app',
    targetId: user.supabaseUserId,
    payload: {
      user_email: email,
      app: result.appKey,
      enabled: result.enabled,
      ...(crmWorkspaceId ? { crm_workspace_id: crmWorkspaceId } : {}),
    },
  });

  return NextResponse.json({
    user_email: email,
    user_id: user.supabaseUserId,
    app: result.appKey,
    enabled: result.enabled,
    ...(crmWorkspaceId ? { crm_workspace_id: crmWorkspaceId } : {}),
  });
}
