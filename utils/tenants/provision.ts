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
  const PROSPECTION_URL = process.env.PROSPECTION_API_URL;
  const PROSPECTION_SECRET = process.env.PROSPECTION_TENANT_API_SECRET;

  if (!PROSPECTION_URL || !PROSPECTION_SECRET) {
    logStep('PROSPECTION', 'Not configured (missing PROSPECTION_API_URL or PROSPECTION_TENANT_API_SECRET), skipping');
    return { success: false, error: 'Not configured' };
  }

  try {
    logStep('PROSPECTION', 'Starting provisioning', { email, userId });

    const timestamp = Date.now();
    const { createHmac: hmac } = await import('crypto');
    const signature = hmac('sha256', PROSPECTION_SECRET)
      .update(`${email}:${timestamp}`)
      .digest('hex');

    const res = await fetch(`${PROSPECTION_URL}/api/tenants/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        name: email.split('@')[0],
        plan: 'freemium',
        timestamp,
        signature,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Provision failed: ${res.status} - ${errorText}`);
    }

    const data = await res.json();
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
  _password: string,
  userId: string
): Promise<{
  success: boolean;
  notifuse?: any;
  prospection?: any;
  errors?: string[];
}> {
  const startTime = Date.now();
  logProvisionStart(email, userId);

  const errors: string[] = [];

  const [notifuseResult, prospectionResult] = await Promise.allSettled([
    provisionNotifuseTenant(email, userId),
    provisionProspectionTenant(email, userId),
  ]);

  const notifuse = notifuseResult.status === 'fulfilled' ? notifuseResult.value : null;
  const prospection = prospectionResult.status === 'fulfilled' ? prospectionResult.value : null;

  if (notifuseResult.status === 'rejected') errors.push(`Notifuse: ${notifuseResult.reason}`);
  else if (!notifuse?.success) errors.push(`Notifuse: ${notifuse?.error}`);

  if (prospectionResult.status === 'rejected') errors.push(`Prospection: ${prospectionResult.reason}`);
  else if (!prospection?.success && prospection?.error !== 'Not configured') {
    errors.push(`Prospection: ${prospection?.error}`);
  }

  const success = !!(notifuse?.success || prospection?.success);
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
