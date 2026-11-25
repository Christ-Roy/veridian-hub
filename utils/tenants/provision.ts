/**
 * Tenant Provisioning Utilities
 * Crée automatiquement les tenants Notifuse + Prospection au signup.
 *
 * Twenty retiré de la stack 2026-05-18.
 */

import { isEmailProvenInDb } from '@/lib/auth/email-proof-provider';
import { logProvisionStart, logProvisionEnd, logStep, logError } from './debug';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
import { workspaceIdDuTenant } from '@/lib/notifuse/workspace-id';
import {
  createProspectionClientFromEnv,
  ProspectionError,
} from '@/lib/prospection/client';
import { abonnerParDefaut } from '@/lib/evenements/naissance';
import { prisma } from '@/lib/prisma';
import { assurerTenantHub as assurerTenantHubDb } from '@/lib/tenants/assurer';

function slugify(email: string): string {
  return email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Cf. `lib/tenants/assurer.ts` : la même règle sert à la création des espaces (CRM, Academy). */
export function assurerTenantHub(email: string, userId: string, nom?: string): Promise<string> {
  return assurerTenantHubDb(prisma, email, userId, nom);
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

    const workspaceName = email.split('@')[0].slice(0, 32);

    const client = new NotifuseClient({ apiUrl, hubSecret });
    const hubTenantId = await assurerTenantHub(email, userId);
    const avant = await prisma.tenant.findUnique({ where: { id: hubTenantId }, select: { notifuseWorkspaceSlug: true, metadata: true } });
    // Un espace déjà noté garde son identifiant, quel qu'il soit ; sinon le Hub le tire de l'id du tenant, le même à chaque rejeu.
    const workspaceId = avant?.notifuseWorkspaceSlug ?? workspaceIdDuTenant(hubTenantId, email);
    const result = await client.provisionWorkspace({
      tenantId: workspaceId,
      ownerEmail: email,
      workspaceName,
      plan: 'free',
      hubUserId: userId,
      hubTenantId,
      emailProven: await isEmailProvenInDb(prisma, userId),
    });

    logStep('NOTIFUSE', result.created ? 'Workspace created' : 'Workspace already existed');
    // Notifuse ne retient le lien au tenant Hub (tenant_id du JWT MCP) qu'à l'update-plan : posé ici
    // pour un espace neuf seulement (plan free, celui qu'il vient de recevoir). Meilleur effort.
    if (result.created) {
      await client
        .updatePlan({ tenantId: result.workspace_id, plan: 'free', hubTenantId })
        .catch((err: unknown) => logStep('NOTIFUSE', 'Lien tenant Hub non posé', { error: err instanceof Error ? err.message : 'erreur' }));
    }

    const tenantId = hubTenantId;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        notifuseWorkspaceSlug: result.workspace_id,
        notifuseUserEmail: email,
        // Un rejeu ne rend pas la clé : celle qu'on a reste, jamais remplacée par du vide.
        ...(result.api_key ? { notifuseApiKey: result.api_key, metadata: { ...((avant?.metadata as Record<string, unknown>) ?? {}), api_key_email: result.api_key_email, workspace_created_at: new Date().toISOString() } as never } : {}),
      },
    });

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

    // Une organisation neuve dont Mail et le CRM sont ouverts : sa liaison par défaut. Jamais bloquant.
    void abonnerParDefaut(prisma, tenantId);

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

    const tenantId = await assurerTenantHub(email, userId);
    const data = await client.provisionTenant({
      email,
      name: email.split('@')[0],
      userId,
      plan: 'freemium',
      emailProven: await isEmailProvenInDb(prisma, userId),
      hubTenantId: tenantId,
    });

    logStep('PROSPECTION', 'Provisioned', { tenantId: data.tenant_id, created: data.created });

    const prospectionData = {
      prospectionApiKey: data.api_key,
      prospectionLoginToken: data.login_url?.split('t=')[1] ?? null,
      prospectionLoginTokenCreatedAt: new Date(),
      prospectionPlan: 'freemium',
      prospectionProvisionedAt: new Date(),
    };

    await prisma.tenant.update({ where: { id: tenantId }, data: prospectionData, select: { id: true } });

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

  // Un seul tenant Hub, assuré avant les appels parallèles (sinon deux créations concurrentes).
  if (app !== 'notifuse') await assurerTenantHub(email, userId);

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
