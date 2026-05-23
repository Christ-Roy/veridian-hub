/**
 * Tenant Provisioning Utilities
 * Crée automatiquement les tenants Notifuse + Prospection au signup.
 *
 * Twenty retiré de la stack 2026-05-18.
 */

import { logProvisionStart, logProvisionEnd, logStep, logError } from './debug';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
import { workspaceIdFromEmail } from '@/lib/notifuse/workspace-id';
import {
  createProspectionClientFromEnv,
  ProspectionError,
} from '@/lib/prospection/client';
import {
  createCreditLeadsClientFromEnv,
  dispatchRefillWelcome,
  getWelcomeLeadsForProspectionPlan,
  type ProspectionLocalPlan,
} from '@/lib/billing/refill-leads';
import { prisma } from '@/lib/prisma';

function slugify(email: string): string {
  return email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// ============================================================
// Notifuse Provisioning
// ============================================================

export async function provisionNotifuseTenant(
  email: string,
  userId: string
): Promise<{
  success: boolean;
  workspaceId?: string;
  apiKey?: string;
  magicLink?: string;
  autoLoginUrl?: string;
  error?: string;
}> {
  try {
    const apiUrl = process.env.NOTIFUSE_API_URL;
    const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
    if (!apiUrl || !hubSecret) {
      throw new Error(
        'Notifuse client not configured (NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET)',
      );
    }

    logStep('NOTIFUSE', 'Starting provisioning', { email, userId });

    const workspaceId = workspaceIdFromEmail(email);
    const workspaceName = email.split('@')[0].slice(0, 32);

    const client = new NotifuseClient({ apiUrl, hubSecret });
    const result = await client.provisionWorkspace({
      tenantId: workspaceId,
      ownerEmail: email,
      workspaceName,
      plan: 'free',
    });

    logStep('NOTIFUSE', result.created ? 'Workspace created' : 'Workspace already existed');

    const tenantData = {
      notifuseWorkspaceSlug: result.workspace_id,
      notifuseApiKey: result.api_key,
      notifuseUserEmail: email,
      metadata: {
        api_key_email: result.api_key_email,
        workspace_created_at: new Date().toISOString(),
      } as any,
    };

    const existingTenant = await prisma.tenant.findFirst({
      where: { userId },
      select: { id: true, metadata: true },
    });

    let tenantId: string;

    if (existingTenant) {
      const mergedMetadata = {
        ...((existingTenant.metadata as Record<string, unknown>) || {}),
        ...tenantData.metadata,
      };
      const updated = await prisma.tenant.update({
        where: { id: existingTenant.id },
        data: { ...tenantData, metadata: mergedMetadata },
        select: { id: true },
      });
      tenantId = updated.id;
    } else {
      const slug = slugify(email);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 15);

      let finalSlug = slug;
      const slugTaken = await prisma.tenant.findUnique({
        where: { slug: finalSlug },
        select: { id: true },
      });
      if (slugTaken) {
        finalSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
      }

      const created = await prisma.tenant.create({
        data: {
          userId,
          name: workspaceName,
          slug: finalSlug,
          status: 'active',
          ...tenantData,
          provisionedAt: new Date(),
          trialEndsAt,
        },
        select: { id: true },
      });
      tenantId = created.id;
    }

    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'success',
          service: 'notifuse',
          message: 'Notifuse provisioned',
          metadata: { workspaceId: result.workspace_id, created: result.created },
        },
      });
    } catch (logErr) {
      console.warn('[NOTIFUSE] provisioning_log create failed:', logErr);
    }

    logStep('NOTIFUSE', 'Stored in DB');

    return {
      success: true,
      workspaceId: result.workspace_id,
      apiKey: result.api_key,
      magicLink: result.magic_link,
      autoLoginUrl: result.auto_login_url,
    };
  } catch (error: any) {
    const message =
      error instanceof NotifuseError
        ? `${error.message} (HTTP ${error.code})`
        : error.message;
    console.error('[Notifuse Provision] Error:', message);
    return {
      success: false,
      error: message,
    };
  }
}

// ============================================================
// Prospection Provisioning
// ============================================================

export async function provisionProspectionTenant(
  email: string,
  userId: string
): Promise<{
  success: boolean;
  tenantId?: string;
  loginUrl?: string;
  apiKey?: string;
  error?: string;
}> {
  const client = createProspectionClientFromEnv();
  if (!client) {
    logStep('PROSPECTION', 'Not configured (missing PROSPECTION_API_URL or PROSPECTION_HUB_API_SECRET/PROSPECTION_TENANT_API_SECRET), skipping');
    return { success: false, error: 'Not configured' };
  }

  try {
    logStep('PROSPECTION', 'Starting provisioning', { email, userId });

    const data = await client.provisionTenant({
      email,
      name: email.split('@')[0],
      userId,
      plan: 'freemium',
    });

    logStep('PROSPECTION', 'Provisioned', { tenantId: data.tenant_id, created: data.created });

    const prospectionData = {
      prospectionApiKey: data.api_key,
      prospectionLoginToken: data.login_url?.split('t=')[1] ?? null,
      prospectionLoginTokenCreatedAt: new Date(),
      prospectionPlan: 'freemium',
      prospectionProvisionedAt: new Date(),
    };

    const existingTenant = await prisma.tenant.findFirst({
      where: { userId },
      select: { id: true },
    });

    let tenantId: string;

    if (existingTenant) {
      const updated = await prisma.tenant.update({
        where: { id: existingTenant.id },
        data: prospectionData,
        select: { id: true },
      });
      tenantId = updated.id;
    } else {
      const slug = slugify(email);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 15);

      let finalSlug = slug;
      const slugTaken = await prisma.tenant.findUnique({
        where: { slug: finalSlug },
        select: { id: true },
      });
      if (slugTaken) {
        finalSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
      }

      const created = await prisma.tenant.create({
        data: {
          userId,
          name: email.split('@')[0],
          slug: finalSlug,
          status: 'active',
          ...prospectionData,
          provisionedAt: new Date(),
          trialEndsAt,
        },
        select: { id: true },
      });
      tenantId = created.id;
    }

    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'success',
          service: 'prospection',
          message: 'Prospection provisioned',
          metadata: { tenantIdRemote: data.tenant_id, created: data.created },
        },
      });
    } catch (logErr) {
      console.warn('[PROSPECTION] provisioning_log create failed:', logErr);
    }

    logStep('PROSPECTION', 'Stored in DB');

    // ─── Welcome leads (best-effort, non-bloquant) ───
    // Le tenant Hub vient d'être créé/mis à jour, le workspace Prospection
    // existe. On crédite le quota welcome du plan freemium (cf
    // PRICING-VERIDIAN.md §78 — 100 leads pour Free). Idempotency_key
    // DÉTERMINISTE (tenantId + welcome_plan) → un retry ou un re-signup
    // réémet la même clé et l'endpoint Prospection renvoie 200 sans
    // double-crédit. Le garde DB Prospection `(workspace_id, welcome_plan)
    // UNIQUE` est un 2e filet en cas de bug clé.
    //
    // Échec ici n'invalide PAS le provisioning : le user a son workspace,
    // un cron de réconciliation (P2) peut rejouer.
    await grantWelcomeLeadsBestEffort({
      hubTenantId: tenantId,
      ownerEmail: email,
      welcomePlan: 'freemium',
    });

    return {
      success: true,
      tenantId: data.tenant_id,
      loginUrl: data.login_url,
      apiKey: data.api_key,
    };
  } catch (error: any) {
    logError('PROSPECTION', error);
    return { success: false, error: error.message };
  }
}

/**
 * Crédite les welcome leads d'un palier sur un tenant Prospection. Best-effort :
 * échec loggué, jamais re-throw. Le caller continue son flow normalement.
 *
 * Utilisé :
 *   - au provisioning Prospection initial (plan freemium → 100 leads)
 *   - à l'upgrade de plan (delta entre paliers, cf dispatcher webhook)
 */
export async function grantWelcomeLeadsBestEffort(args: {
  hubTenantId: string;
  ownerEmail: string;
  welcomePlan: ProspectionLocalPlan;
  /** Optionnel : override quantity (utilisé pour les deltas d'upgrade). */
  quantityOverride?: number;
}): Promise<{ success: boolean; error?: string; quantity?: number }> {
  const quantity =
    args.quantityOverride ??
    getWelcomeLeadsForProspectionPlan(args.welcomePlan);

  if (quantity <= 0) {
    logStep('PROSPECTION', `Welcome leads skip — quantity=${quantity} for plan ${args.welcomePlan}`);
    return { success: true, quantity: 0 };
  }

  const client = createCreditLeadsClientFromEnv();
  if (!client) {
    logStep(
      'PROSPECTION',
      'Welcome leads skip — PROSPECTION_API_URL / PROSPECTION_HUB_API_SECRET missing',
    );
    return { success: false, error: 'client_not_configured' };
  }

  // tenantIdOrEmail envoyé dans le path Prospection : on passe l'email
  // owner (résolution dual UUID/email côté Prospection). Le keyTenantId
  // utilisé pour générer l'idempotency_key reste le Hub Tenant.id, qui est
  // stable et ne dépend pas de l'email (si l'email change un jour).
  const result = await dispatchRefillWelcome(client, {
    tenantIdOrEmail: args.ownerEmail,
    quantity,
    welcomePlan: args.welcomePlan,
    keyTenantId: args.hubTenantId,
  });

  if (result.ok) {
    logStep(
      'PROSPECTION',
      `Welcome leads credited: plan=${args.welcomePlan} quantity=${quantity} ` +
        `attempts=${result.attempts} replay=${result.response.idempotent_replay ?? false}`,
    );
    return { success: true, quantity };
  }

  console.warn(
    `[PROSPECTION] Welcome leads grant failed (non-blocking) — plan=${args.welcomePlan} ` +
      `quantity=${quantity} status=${result.status ?? 'network'} err=${result.error}`,
  );
  return { success: false, error: result.error, quantity };
}

// ============================================================
// Provision All (called at signup)
// ============================================================

export async function provisionTenants(
  email: string,
  userId: string,
  options: { app?: 'notifuse' | 'prospection' | 'all' } = {},
): Promise<{
  success: boolean;
  notifuse?: any;
  prospection?: any;
  errors?: string[];
}> {
  const app = options.app ?? 'all';
  const startTime = Date.now();
  logProvisionStart(email, userId);

  const errors: string[] = [];

  const tasks: Array<Promise<any>> = [];
  const wantsNotifuse = app === 'notifuse' || app === 'all';
  const wantsProspection = app === 'prospection' || app === 'all';

  tasks.push(
    wantsNotifuse
      ? provisionNotifuseTenant(email, userId)
      : Promise.resolve(null),
  );
  tasks.push(
    wantsProspection
      ? provisionProspectionTenant(email, userId)
      : Promise.resolve(null),
  );

  const [notifuseResult, prospectionResult] = await Promise.allSettled(tasks);

  const notifuse = notifuseResult.status === 'fulfilled' ? notifuseResult.value : null;
  const prospection = prospectionResult.status === 'fulfilled' ? prospectionResult.value : null;

  if (wantsNotifuse) {
    if (notifuseResult.status === 'rejected') errors.push(`Notifuse: ${notifuseResult.reason}`);
    else if (!notifuse?.success) errors.push(`Notifuse: ${notifuse?.error}`);
  }

  if (wantsProspection) {
    if (prospectionResult.status === 'rejected') errors.push(`Prospection: ${prospectionResult.reason}`);
    else if (!prospection?.success && prospection?.error !== 'Not configured') {
      errors.push(`Prospection: ${prospection?.error}`);
    }
  }

  const success = !!(
    (wantsNotifuse && notifuse?.success) ||
    (wantsProspection && prospection?.success)
  );
  const duration = Date.now() - startTime;

  logProvisionEnd(success, duration, errors.length > 0 ? errors : undefined);

  console.log('[Provision Tenants] Summary:', {
    success,
    notifuseSuccess: notifuse?.success,
    prospectionSuccess: prospection?.success,
    duration_ms: duration,
    errors: errors.length,
  });

  return {
    success,
    notifuse,
    prospection,
    errors: errors.length > 0 ? errors : undefined,
  };
}
