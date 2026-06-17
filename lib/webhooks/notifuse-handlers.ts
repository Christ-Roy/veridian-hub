/**
 * Handlers v1.4 du webhook Notifuse → Hub.
 *
 * Extrait de `app/api/webhooks/notifuse/route.ts` pour permettre les tests
 * unitaires (Next.js App Router n'autorise que les exports `runtime`,
 * `dynamic`, `revalidate`, etc. — pas une `HandlerTable` arbitraire).
 *
 * Convention :
 *   - Chaque handler reçoit la `V14WebhookPayload` désérialisée + dédupliquée
 *     (la dédup PK (app, idempotency_key) est gérée en amont par
 *     `lib/webhooks/receiver.handleWebhook`).
 *   - Throw → la row dédup garde `processed_at = NULL` et l'app peut
 *     réessayer (cf §7.1 du contrat). Pas de retry interne ici.
 *   - No-op silencieux (console.info uniquement) = comportement par défaut
 *     pour les events stub en attendant leur câblage métier complet.
 */

import { prisma } from '@/lib/prisma';
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
import { ingestProspectEvent } from '@/lib/prospect/ingest';

/**
 * Extrait `contact_email` et `vid` du `data` d'un event comportemental v1.4.
 * Tolérant : champs absents = undefined (la jointure V1 se fait par email,
 * un event sans email reste ingéré mais non scoré).
 */
function behavioralFields(data: Record<string, unknown> | undefined): {
  contactEmail?: string;
  vid?: string;
} {
  const d = data ?? {};
  const contactEmail =
    typeof d.contact_email === 'string' ? d.contact_email : undefined;
  const vid = typeof d.vid === 'string' ? d.vid : undefined;
  return { contactEmail, vid };
}

export const v14Handlers: HandlerTable = {
  'tenant.touched': async (payload) => {
    // Stub : la row dédup garde le payload pour audit. Quand le ticket
    // §5.18 sera implémenté côté Hub on viendra ici update
    // tenant.lastActivityAt + reset deletedAt si soft_deleted.
    console.info(
      '[webhook:notifuse] tenant.touched',
      payload.tenant_id,
      payload.data,
    );
  },

  'tenant.member_role_changed': async (payload) => {
    // Stub : §5.18.4 + §11bis.3 — sync best-effort vers
    // tenant_members.last_known_app_role. Implémentation détaillée dans
    // le ticket dédié quand les apps livreront l'event réel.
    console.info(
      '[webhook:notifuse] tenant.member_role_changed',
      payload.tenant_id,
      payload.data,
    );
  },

  // ==========================================================================
  // Niveau 2 du tenant sync — materialisation des events dans
  // `tenants.metadata.notifuse_*`. Cf todo/2026-05-20-tenant-sync-strategy.md.
  //
  // Note coexistence : ces handlers v1.4 traitent EN PLUS des handlers HMAC
  // legacy de `app/api/webhooks/notifuse/route.ts` (héritage). Tant que le
  // fork Notifuse n'a pas migré sur v1.4 Bearer, les events `tenant.suspended/
  // resumed/deleted` arrivent par la voie legacy. Les handlers v1.4 ci-dessous
  // sont prêts à prendre le relais sans changement quand Notifuse migrera.
  // ==========================================================================

  'tenant.suspended': async (payload) => {
    await applySuspended(
      'notifuse',
      payload.tenant_id,
      payload.data as { suspended_at?: string; reason?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.resumed': async (payload) => {
    await applyResumed(
      'notifuse',
      payload.tenant_id,
      payload.data as { resumed_at?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.soft_deleted': async (payload) => {
    await applySoftDeleted(
      'notifuse',
      payload.tenant_id,
      payload.data as { soft_deleted_at?: string; reason?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.purged': async (payload) => {
    await applyPurged(
      'notifuse',
      payload.tenant_id,
      payload.data as { purged_at?: string; rows_deleted?: number } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.owner_changed': async (payload) => {
    await applyOwnerChanged(
      'notifuse',
      payload.tenant_id,
      payload.data as
        | { old_owner_email?: string; new_owner_email?: string }
        | undefined,
      payload.occurred_at,
    );
  },

  'tenant.quota_exceeded': async (payload) => {
    await applyQuotaExceeded(
      'notifuse',
      payload.tenant_id,
      payload.data as
        | { quota_type?: string; current?: number; limit?: number }
        | undefined,
      payload.occurred_at,
    );
  },

  'tenant.member_added': async (payload) => {
    await applyMemberEvent(
      'notifuse',
      payload.tenant_id,
      'added',
      payload.data as { user_email?: string; role?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.member_removed': async (payload) => {
    await applyMemberEvent(
      'notifuse',
      payload.tenant_id,
      'removed',
      payload.data as { user_email?: string; reason?: string } | undefined,
      payload.occurred_at,
    );
  },

  'tenant.activity_threshold_reached': async (payload) => {
    // Signal d'engagement métier émis par Notifuse au 5e mail envoyé.
    // Entry point de la trial state machine cross-app (cf
    // `app/api/cron/trial-tick/route.ts` et `docs/PRICING-VERIDIAN.md`).
    //
    // Sémantique : UPSERT idempotent. Si la row existe déjà (= replay
    // d'event, ou Notifuse a re-émis), on ne touche pas à eligible_at
    // ni à l'état avancé (trial_active, expired, converted). On met
    // juste à jour updated_at pour tracer le replay.
    //
    // Si la row n'existe pas → INSERT state=eligible, eligible_at=NOW.
    // Le cron tick activera le trial après 48h.
    //
    // PK composite (tenant_id, app) garantit qu'un user qui re-déclenche
    // le signal après un trial expiré ne ré-ouvre PAS un nouveau trial
    // (1 trial par tenant lifetime, décision figée Robert 2026-05-21).
    const now = new Date();
    await prisma.tenantTrial.upsert({
      where: {
        tenantId_app: { tenantId: payload.tenant_id, app: 'notifuse' },
      },
      create: {
        tenantId: payload.tenant_id,
        app: 'notifuse',
        state: 'eligible',
        eligibleAt: now,
      },
      update: {
        // Replay : on ne touche PAS state/eligible_at/trial_*. Juste
        // updated_at via @updatedAt côté Prisma — on déclenche en
        // re-écrivant un champ stable.
        updatedAt: now,
      },
    });
    console.info(
      '[webhook:notifuse] tenant.activity_threshold_reached',
      payload.tenant_id,
      'trial.eligible',
    );
  },

  // ==========================================================================
  // Events COMPORTEMENTAUX — réconciliateur cold↔web + scoring prospect.
  // Cf docs/CONTRAT-HUB.md §7.5 (standard d'event comportemental) +
  // todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md.
  //
  // Ces 3 handlers sont la voie STANDARD v1.4 Bearer. Le fork Notifuse émet
  // aujourd'hui via la voie LEGACY HMAC (dispatchLegacyEvent dans la route) —
  // les deux voies normalisent et appellent le MÊME ingestProspectEvent.
  // Analytics (page.hit) arrivera par sa propre route /api/webhooks/analytics
  // (v1.4 Bearer) et appellera le même ingest, sans rien changer ici.
  // ==========================================================================

  'email.opened': async (payload) => {
    const { contactEmail, vid } = behavioralFields(payload.data);
    await ingestProspectEvent({
      app: 'notifuse',
      eventType: 'email.opened',
      workspaceSlug: payload.tenant_id,
      idempotencyKey: payload.idempotency_key,
      occurredAt: payload.occurred_at,
      contactEmail,
      vid,
      data: payload.data ?? null,
    });
  },

  'email.clicked': async (payload) => {
    const { contactEmail, vid } = behavioralFields(payload.data);
    await ingestProspectEvent({
      app: 'notifuse',
      eventType: 'email.clicked',
      workspaceSlug: payload.tenant_id,
      idempotencyKey: payload.idempotency_key,
      occurredAt: payload.occurred_at,
      contactEmail,
      vid,
      data: payload.data ?? null,
    });
  },

  'email.replied': async (payload) => {
    const { contactEmail, vid } = behavioralFields(payload.data);
    await ingestProspectEvent({
      app: 'notifuse',
      eventType: 'email.replied',
      workspaceSlug: payload.tenant_id,
      idempotencyKey: payload.idempotency_key,
      occurredAt: payload.occurred_at,
      contactEmail,
      vid,
      data: payload.data ?? null,
    });
  },

  // email.sent : baseline 0 point au scoring, mais INGÉRÉ pour que le stage
  // CRM NEW→SCREENING se déclenche (hasEmailSent dans push-to-crm.ts). Parité
  // bridge. L'adresse peut arriver en `contact_email` (format comportemental)
  // ou `to` (EmailSentEventData) — on tolère les deux.
  'email.sent': async (payload) => {
    const { contactEmail, vid } = behavioralFields(payload.data);
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const email =
      contactEmail ?? (typeof data.to === 'string' ? data.to : undefined);
    await ingestProspectEvent({
      app: 'notifuse',
      eventType: 'email.sent',
      workspaceSlug: payload.tenant_id,
      idempotencyKey: payload.idempotency_key,
      occurredAt: payload.occurred_at,
      contactEmail: email,
      vid,
      data: payload.data ?? null,
    });
  },
};
