import { NextResponse } from 'next/server';

import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
import { prisma } from '@/lib/prisma';

export interface ResolvedNotifuseTenant {
  hubTenantId: string;
  notifuseWorkspaceSlug: string;
  notifuseUserEmail: string | null;
  notifuseApiKey: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Construit un `NotifuseClient` à partir des env vars Hub. Renvoie une
 * `NextResponse` 500 si la configuration est manquante.
 */
export function buildNotifuseClient(): NotifuseClient | NextResponse {
  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl || !hubSecret) {
    return NextResponse.json(
      { error: 'Notifuse client not configured (NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET)' },
      { status: 500 },
    );
  }
  return new NotifuseClient({ apiUrl, hubSecret });
}

/**
 * Résout un tenant Hub (id Prisma) et vérifie qu'il a bien un workspace
 * Notifuse provisionné. Renvoie le tenant ou une `NextResponse` 404/409.
 */
export async function resolveNotifuseTenant(
  hubTenantId: string,
): Promise<ResolvedNotifuseTenant | NextResponse> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: hubTenantId },
    select: {
      id: true,
      notifuseWorkspaceSlug: true,
      notifuseUserEmail: true,
      notifuseApiKey: true,
      metadata: true,
    },
  });

  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  if (!tenant.notifuseWorkspaceSlug) {
    return NextResponse.json(
      { error: 'Tenant Notifuse workspace not provisioned' },
      { status: 409 },
    );
  }

  return {
    hubTenantId: tenant.id,
    notifuseWorkspaceSlug: tenant.notifuseWorkspaceSlug,
    notifuseUserEmail: tenant.notifuseUserEmail,
    notifuseApiKey: tenant.notifuseApiKey,
    metadata: (tenant.metadata as Record<string, unknown> | null) ?? {},
  };
}

/**
 * Convertit une erreur (typée ou non) issue d'un appel `NotifuseClient` en
 * `NextResponse` propre. Préserve le status HTTP du fork Notifuse quand il est
 * dans la plage 4xx, sinon renvoie 502 (bad gateway = Notifuse en panne).
 */
export function notifuseErrorResponse(err: unknown): NextResponse {
  if (err instanceof NotifuseError) {
    const status = err.code >= 400 && err.code < 600 ? err.code : 502;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return NextResponse.json({ error: message }, { status: 500 });
}
