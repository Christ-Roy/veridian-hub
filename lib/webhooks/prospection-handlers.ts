/**
 * Handlers v1.4 du webhook Prospection → Hub.
 *
 * Extrait dans son propre module (pas inline dans `app/api/webhooks/prospection/route.ts`)
 * pour pouvoir être testé unitairement — Next.js App Router refuse les
 * exports arbitraires depuis un route file.
 *
 * Cf `lib/webhooks/notifuse-handlers.ts` pour le pattern miroir côté Notifuse
 * et `lib/sync/snapshot-updater.ts` pour la matérialisation partagée.
 *
 * Référence : `todo/2026-05-20-tenant-sync-strategy.md` Niveau 2,
 *             `docs/CONTRAT-HUB.md` §7.1 (events v1.5).
 */

import type { HandlerTable } from '@/lib/webhooks/receiver';
import {
  applyMemberEvent,
  applyOwnerChanged,
  applyPurged,
  applyQuotaExceeded,
  applyResumed,
  applySoftDeleted,
  applySuspended,
} from '@/lib/sync/snapshot-updater';

export const prospectionHandlers: HandlerTable = {
  'tenant.touched': async (payload) => {
    console.info(
      '[webhook:prospection] tenant.touched',
      payload.tenant_id,
      payload.data,
    );
  },

  'tenant.member_role_changed': async (payload) => {
    console.info(
      '[webhook:prospection] tenant.member_role_changed',
      payload.tenant_id,
      payload.data,
    );
  },

  'tenant.activity_threshold_reached': async (payload) => {
    // Prospection peut émettre ce signal au futur (ex: 50 leads scrappés).
    // Pour l'instant le déclencheur de trial est Notifuse-only (cf
    // `lib/webhooks/notifuse-handlers.ts`). On log + drop ici, le ticket
    // dédié branchera l'upsert tenantTrial(app='prospection') quand le
    // business le justifiera.
    console.info(
      '[webhook:prospection] tenant.activity_threshold_reached',
      payload.tenant_id,
      payload.data,
    );
  },

  // ==========================================================================
  // Niveau 2 du tenant sync — materialisation dans `tenants.metadata.prospection_*`.
  // ==========================================================================

  'tenant.suspended': async (payload) => {
    await applySuspended(
      'prospection',
      payload.tenant_id,
      payload.data as { suspended_at?: string; reason?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.resumed': async (payload) => {
    await applyResumed(
      'prospection',
      payload.tenant_id,
      payload.data as { resumed_at?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.soft_deleted': async (payload) => {
    await applySoftDeleted(
      'prospection',
      payload.tenant_id,
      payload.data as { soft_deleted_at?: string; reason?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.purged': async (payload) => {
    await applyPurged(
      'prospection',
      payload.tenant_id,
      payload.data as { purged_at?: string; rows_deleted?: number } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.owner_changed': async (payload) => {
    await applyOwnerChanged(
      'prospection',
      payload.tenant_id,
      payload.data as
        | { old_owner_email?: string; new_owner_email?: string }
        | undefined,
      payload.occurred_at,
    );
  },

  'tenant.quota_exceeded': async (payload) => {
    await applyQuotaExceeded(
      'prospection',
      payload.tenant_id,
      payload.data as
        | { quota_type?: string; current?: number; limit?: number }
        | undefined,
      payload.occurred_at,
    );
  },

  'tenant.member_added': async (payload) => {
    await applyMemberEvent(
      'prospection',
      payload.tenant_id,
      'added',
      payload.data as { user_email?: string; role?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.member_removed': async (payload) => {
    await applyMemberEvent(
      'prospection',
      payload.tenant_id,
      'removed',
      payload.data as { user_email?: string; reason?: string } | undefined,
      payload.occurred_at,
    );
  },
};
