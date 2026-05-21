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
};
