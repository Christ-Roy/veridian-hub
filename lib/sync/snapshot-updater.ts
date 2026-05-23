/**
 * Niveau 2 du tenant sync — Webhook push handlers (partie matérialisation).
 *
 * Helpers partagés entre `lib/webhooks/notifuse-handlers.ts` et
 * `lib/webhooks/prospection-handlers.ts` pour appliquer les events
 * `tenant.*` au snapshot Hub (champs typed + `tenants.metadata.<app>_*`).
 *
 * Convention de matérialisation :
 *   - status → `tenants.metadata.<app>_status` ('active' | 'suspended' | 'deleted')
 *   - suspended_at / reason → `<app>_suspended_at`, `<app>_suspended_reason`
 *   - resumed_at → reset des deux champs ci-dessus
 *   - soft_deleted_at → `<app>_soft_deleted_at`
 *   - purged_at → `<app>_purged_at`, `<app>_purged_rows`
 *   - owner_changed → `<app>_owner_changed_at`, `<app>_owner_history` (10 derniers)
 *   - quota_exceeded → `<app>_quota_exceeded_at`, `<app>_quota_type`
 *   - member_added / removed → `<app>_member_events` (50 derniers, append-only)
 *
 * Tenant lookup :
 *   - Notifuse : `tenant_id` du payload = `notifuseWorkspaceSlug` (legacy)
 *   - Prospection : `tenant_id` = `id` Hub (UUID) ou metadata.prospection.tenant_id
 *
 * Idempotence garantie en amont par le receiver (PK dedup). Les writes
 * ici sont également idempotents par construction (overwrite, sauf
 * append-only owner_history / member_events bornés).
 *
 * Référence : `todo/2026-05-20-tenant-sync-strategy.md` Niveau 2,
 *             `docs/CONTRAT-HUB.md` §7.1 (events v1.5).
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import type { SyncApp } from '@/lib/sync/types';

/** Métadonnées tenant — JSONB plat, valeurs strings/numbers/arrays. */
type TenantMetadata = Record<string, unknown>;

/**
 * Résout un tenant Hub à partir d'un `tenant_id` reçu côté webhook.
 *
 * Stratégie de résolution (premier hit) :
 *   1. Si c'est un UUID → match `Tenant.id`
 *   2. Sinon match `notifuseWorkspaceSlug = tenant_id` (notifuse)
 *   3. Sinon match `metadata.<app>.workspace_id = tenant_id` (futur prospection)
 *
 * Renvoie null si pas trouvé. Le caller log alors un warning et drop l'event
 * (mais la row dedup reste écrite, pas de retry inutile).
 */
export async function resolveTenantByExternalId(
  app: SyncApp,
  tenantId: string,
): Promise<{ id: string; metadata: TenantMetadata } | null> {
  // Tentative 1 : tenant.id Hub (UUID)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    const byId = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, metadata: true },
    });
    if (byId) {
      return {
        id: byId.id,
        metadata: (byId.metadata as TenantMetadata | null) ?? {},
      };
    }
  }

  // Tentative 2 : notifuseWorkspaceSlug (Notifuse legacy)
  if (app === 'notifuse') {
    const bySlug = await prisma.tenant.findFirst({
      where: { notifuseWorkspaceSlug: tenantId },
      select: { id: true, metadata: true },
    });
    if (bySlug) {
      return {
        id: bySlug.id,
        metadata: (bySlug.metadata as TenantMetadata | null) ?? {},
      };
    }
  }

  // Tentative 3 : metadata.<app>.workspace_id (généralisable)
  // On utilise un raw fragment Prisma pour requêter un champ JSONB profond.
  const matched = await prisma.$queryRaw<Array<{ id: string; metadata: unknown }>>(
    Prisma.sql`
      SELECT id, metadata
      FROM hub_app.tenants
      WHERE metadata -> ${app}::text ->> 'workspace_id' = ${tenantId}
      LIMIT 1
    `,
  );
  if (matched.length > 0) {
    return {
      id: matched[0].id,
      metadata: (matched[0].metadata as TenantMetadata | null) ?? {},
    };
  }

  return null;
}

/** Append-only borné. Garde les N derniers events. */
function pushBounded<T>(arr: unknown, item: T, max: number): T[] {
  const safe = Array.isArray(arr) ? (arr as T[]) : [];
  return [...safe, item].slice(-max);
}

/**
 * Applique un event `tenant.suspended` à un tenant Hub.
 * Idempotent : un replay overwrite avec la même valeur, pas de side effect.
 */
export async function applySuspended(
  app: SyncApp,
  tenantId: string,
  data: { suspended_at?: string; reason?: string } | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applySuspended: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const next: TenantMetadata = {
    ...meta,
    [`${app}_status`]: 'suspended',
    [`${app}_suspended_at`]: data?.suspended_at ?? occurredAt,
    [`${app}_suspended_reason`]: data?.reason ?? null,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}

/** Reset des champs suspend (status → active). */
export async function applyResumed(
  app: SyncApp,
  tenantId: string,
  data: { resumed_at?: string } | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applyResumed: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const next: TenantMetadata = {
    ...meta,
    [`${app}_status`]: 'active',
    [`${app}_suspended_at`]: null,
    [`${app}_suspended_reason`]: null,
    [`${app}_resumed_at`]: data?.resumed_at ?? occurredAt,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}

/** Marque `<app>_soft_deleted_at`. Status passe à 'deleted'. */
export async function applySoftDeleted(
  app: SyncApp,
  tenantId: string,
  data: { soft_deleted_at?: string; reason?: string } | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applySoftDeleted: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const next: TenantMetadata = {
    ...meta,
    [`${app}_status`]: 'deleted',
    [`${app}_soft_deleted_at`]: data?.soft_deleted_at ?? occurredAt,
    [`${app}_soft_deleted_reason`]: data?.reason ?? null,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}

/** Marque `<app>_purged_at`. Status reste 'deleted'. */
export async function applyPurged(
  app: SyncApp,
  tenantId: string,
  data: { purged_at?: string; rows_deleted?: number } | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applyPurged: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const next: TenantMetadata = {
    ...meta,
    [`${app}_status`]: 'deleted',
    [`${app}_purged_at`]: data?.purged_at ?? occurredAt,
    [`${app}_purged_rows`]: data?.rows_deleted ?? null,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}

/** Append-only `<app>_owner_history` (10 derniers). */
export async function applyOwnerChanged(
  app: SyncApp,
  tenantId: string,
  data: { old_owner_email?: string; new_owner_email?: string } | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applyOwnerChanged: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const history = pushBounded(
    meta[`${app}_owner_history`],
    {
      old: data?.old_owner_email ?? null,
      new: data?.new_owner_email ?? null,
      at: occurredAt,
    },
    10,
  );
  const next: TenantMetadata = {
    ...meta,
    [`${app}_owner_changed_at`]: occurredAt,
    [`${app}_owner_history`]: history,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}

/** Soft alert, on garde juste les coords du dernier événement. */
export async function applyQuotaExceeded(
  app: SyncApp,
  tenantId: string,
  data:
    | { quota_type?: string; current?: number; limit?: number }
    | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applyQuotaExceeded: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const next: TenantMetadata = {
    ...meta,
    [`${app}_quota_exceeded_at`]: occurredAt,
    [`${app}_quota_type`]: data?.quota_type ?? null,
    [`${app}_quota_current`]: data?.current ?? null,
    [`${app}_quota_limit`]: data?.limit ?? null,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}

export type MemberEventKind = 'added' | 'removed';

/** Append-only `<app>_member_events` (50 derniers). */
export async function applyMemberEvent(
  app: SyncApp,
  tenantId: string,
  kind: MemberEventKind,
  data: { user_email?: string; role?: string; reason?: string } | undefined,
  occurredAt: string,
): Promise<void> {
  const resolved = await resolveTenantByExternalId(app, tenantId);
  if (!resolved) {
    console.warn(
      `[sync] applyMemberEvent: tenant not found app=${app} tenant_id=${tenantId}`,
    );
    return;
  }
  const meta = resolved.metadata;
  const events = pushBounded(
    meta[`${app}_member_events`],
    {
      kind,
      email: data?.user_email ?? null,
      role: data?.role ?? null,
      reason: data?.reason ?? null,
      at: occurredAt,
    },
    50,
  );
  const next: TenantMetadata = {
    ...meta,
    [`${app}_member_events`]: events,
  };
  await prisma.tenant.update({
    where: { id: resolved.id },
    data: { metadata: next as object },
  });
}
