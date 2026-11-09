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
import { isCanonicalPlan, readAppPlan, setAppPlan } from '@/lib/plans/app-plan';

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

  // Analytics : le plan du Hub (sinon free) est posé chez Rybbit dès l'activation. Sans compte
  // Rybbit relié, Rybbit répond tenant_not_found et rien n'est écrit : l'écart se lit dans reconcile.
  let analyticsPlan: string | undefined;
  if (parsed.data.app === 'analytics' && parsed.data.enabled) {
    const tenant = await prisma.tenant.findFirst({
      where: { userId: user.supabaseUserId, deletedAt: null },
      select: { id: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    });
    if (tenant) {
      const actuel = readAppPlan(tenant.metadata, 'analytics').plan;
      const pushed = await setAppPlan(prisma, {
        tenantId: tenant.id,
        app: 'analytics',
        plan: isCanonicalPlan(actuel) ? actuel : 'free',
        planSource: 'grant_manual',
        reason: 'activation analytics',
        setBy: resolveActor(request.headers, authResult.sessionEmail),
      });
      analyticsPlan = pushed.ok ? 'posé' : `non posé : ${pushed.error}`;
    }
  }

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
    ...(analyticsPlan ? { analytics_plan: analyticsPlan } : {}),
  });
}
