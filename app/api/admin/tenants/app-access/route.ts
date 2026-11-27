/**
 * POST /api/admin/tenants/app-access
 *
 * Active ou désactive une app GATED (twenty/CRM, analytics, cms, academy) pour un
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
 *   { user_email: string, app: 'twenty'|'analytics'|'cms'|'academy', enabled: boolean }
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
import { lierAuHub } from '@/lib/apps/lier-hub';
import { provisionnerAnalytics } from '@/lib/analytics/provision';
import { ensureAcademyWorkspace } from '@/lib/academy/provision';
import { ensureCrmWorkspace } from '@/lib/crm/provision';
import { choisirPlanInitial, setAppPlan } from '@/lib/plans/app-plan';

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
    select: { id: true, email: true, supabaseUserId: true, emailVerified: true, name: true },
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

  // Le CRM et Academy ont un espace par utilisateur, créé ici et à la première ouverture (§3.8) :
  // pas d'activation sans espace.
  let crmWorkspaceId: string | undefined;
  let academyWorkspaceId: string | undefined;
  const espaceApp = parsed.data.app === 'twenty' ? 'crm' : parsed.data.app === 'academy' ? 'academy' : null;
  if (espaceApp && parsed.data.enabled) {
    if (!user.emailVerified) {
      return NextResponse.json(
        { error: 'email_not_proven', message: `L'adresse n'est pas prouvée : aucun espace ${espaceApp} n'est créé.` },
        { status: 409 },
      );
    }
    const qui = { hubUserId: user.supabaseUserId, email, name: user.name };
    const actorOpts = { actorEmail: resolveActor(request.headers, authResult.sessionEmail) };
    const provision =
      espaceApp === 'crm' ? await ensureCrmWorkspace(prisma, qui, actorOpts) : await ensureAcademyWorkspace(prisma, qui, actorOpts);
    if (!provision.ok) {
      console.warn(JSON.stringify({ tag: '[app-access]', level: 'warn', app: espaceApp, hub_user_id: user.supabaseUserId, error: String(provision.error).slice(0, 120) }));
      return NextResponse.json(
        { error: provision.error === 'tenant_not_found' ? 'tenant_not_found' : `${espaceApp}_provision_failed`, detail: provision.error },
        { status: provision.error === 'tenant_not_found' ? 404 : provision.error === `${espaceApp}_not_configured` ? 503 : 424 },
      );
    }
    if (espaceApp === 'crm') crmWorkspaceId = provision.workspaceId;
    else academyWorkspaceId = provision.workspaceId;
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
  let analyticsLien: string | undefined;
  let analyticsProvision: string | undefined;
  if (parsed.data.app === 'analytics' && parsed.data.enabled) {
    const tenant = await prisma.tenant.findFirst({
      where: { userId: user.supabaseUserId, deletedAt: null },
      select: { id: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    });
    if (tenant) {
      // Dès l'activation, Analytics crée la personne et son organisation reliée (parente, 26/11) : un client sans site peut entrer.
      // Route absente chez Analytics : rien n'est inventé, l'issue est dite dans la réponse.
      if (user.emailVerified) {
        const p = await provisionnerAnalytics(prisma, { hubUserId: user.supabaseUserId, email: user.email, name: user.name ?? null }, tenant.id).catch(
          (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message.slice(0, 80) : 'erreur' }),
        );
        analyticsProvision = p.ok ? `organisation ${p.organizationId}` : (('attente' in p && p.attente) || `non créée : ${'error' in p ? p.error : 'inconnu'}`);
      } else analyticsProvision = 'adresse à prouver : rien créé';
      // Un plan déjà choisi au Hub est repoussé avec sa source ; sinon rien : un free par défaut
      // marqué grant_manual serait immunisé contre Stripe (décision du 22/11).
      const choisi = choisirPlanInitial(tenant.metadata, 'analytics');
      if (choisi) {
        const pushed = await setAppPlan(prisma, {
          tenantId: tenant.id,
          app: 'analytics',
          plan: choisi.plan,
          planSource: choisi.planSource,
          reason: 'activation analytics',
          setBy: resolveActor(request.headers, authResult.sessionEmail),
        });
        analyticsPlan = pushed.ok ? 'posé' : `non posé : ${pushed.error}`;
      } else {
        analyticsPlan = 'aucun plan choisi : celui de l\'app reste (free)';
      }
      // Lien d'espace pour le tenant_id du JWT MCP (lien seul, jamais écrasé) : sans lui, choisir
      // cet espace par la porte rendait tenant_not_linked (mesuré le 09/11).
      const lien = await lierAuHub('analytics', { hubUserId: user.supabaseUserId, hubTenantId: tenant.id }).catch(
        (err: unknown) => ({ linked: false, raison: err instanceof Error ? err.message.slice(0, 80) : 'erreur' }),
      );
      analyticsLien = lien.linked ? lien.raison : `non relié : ${lien.raison}`;
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
      ...(academyWorkspaceId ? { academy_workspace_id: academyWorkspaceId } : {}),
    },
  });

  return NextResponse.json({
    user_email: email,
    user_id: user.supabaseUserId,
    app: result.appKey,
    enabled: result.enabled,
    ...(crmWorkspaceId ? { crm_workspace_id: crmWorkspaceId } : {}),
    ...(academyWorkspaceId ? { academy_workspace_id: academyWorkspaceId } : {}),
    ...(analyticsPlan ? { analytics_plan: analyticsPlan } : {}),
    ...(analyticsLien ? { analytics_lien: analyticsLien } : {}),
    ...(analyticsProvision ? { analytics_provision: analyticsProvision } : {}),
  });
}
