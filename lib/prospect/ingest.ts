/**
 * Ingestion d'un event COMPORTEMENTAL dans le réconciliateur prospect.
 *
 * Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
 * Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
 * Standard : docs/CONTRAT-HUB.md §7.5.
 *
 * Point d'entrée UNIQUE appelé par les DEUX voies de transport :
 *   - LEGACY HMAC  (app/api/webhooks/notifuse/route.ts → dispatchLegacyEvent) :
 *     voie qu'emprunte le fork Notifuse aujourd'hui (X-Veridian-Notifuse-
 *     Signature, payload {event_id, event_type, tenant_id, occurred_at, data}).
 *   - v1.4 BEARER  (lib/webhooks/notifuse-handlers.ts → v14Handlers) : voie
 *     STANDARD des nouvelles apps (Analytics page.hit), via
 *     `lib/webhooks/receiver.handleWebhook`.
 *
 * Les deux voies normalisent leur payload en `IngestEventInput` puis appellent
 * `ingestProspectEvent`.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LE HUB EST UN BUS D'EVENTS (archi tranchée Robert 2026-06-17).            │
 * │                                                                           │
 * │ L'ingestion PERSISTE l'event comportemental dans `prospect_events`,       │
 * │ POINT. Le Hub ne calcule ni ne stocke AUCUN score. Le scoring est sorti   │
 * │ du Hub : il vit dans le CRM Twenty de CHAQUE TENANT, réglable par lui      │
 * │ (barème/seuils/presets via les workflows natifs du CRM, par workspace).   │
 * │                                                                           │
 * │ Le Hub RELAIE les events temps réel vers le CRM du tenant (timeline       │
 * │ activity), sans batch ni cron. Les events sont la donnée brute et la      │
 * │ vérité, indépendants de tout scoring. Un bug/refonte de barème côté CRM    │
 * │ ne touche jamais la réception/persistance des events ici.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Idempotence : deux couches.
 *   1. Transport : la dédup webhook (legacy = metadata.notifuse_processed_events ;
 *      v1.4 = PK webhook_dedup) protège la route d'un replay.
 *   2. Ingestion : `prospect_events.idempotency_key` UNIQUE. Un replay qui a
 *      franchi la couche 1 viole l'unique → on AVALE (no-op gracieux).
 *
 * Transaction : l'INSERT vit dans une `prisma.$transaction` (une seule écriture
 * pour l'instant, mais la tx garde la porte ouverte à un INSERT multi-tables
 * atomique sans changer le contrat d'erreur). Une erreur de persistance (hors
 * P2002 = replay, avalé) remonte au caller pour retry (legacy = 500 → backoff
 * app ; v1.4 = throw → processed_at NULL → retry app).
 *
 * Best-effort : la résolution du tenant UUID ne bloque jamais l'ingestion
 * (workspace orphelin = event ingéré quand même, tenant_uuid NULL, forensics).
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { resolveTenantByExternalId } from '@/lib/sync/snapshot-updater';

/** Entrée normalisée d'un event comportemental, indépendante du transport. */
export interface IngestEventInput {
  /** App émettrice : 'notifuse' | 'analytics' (extensible). */
  app: 'notifuse' | 'analytics';
  /** Type canonique : email.opened/clicked/replied | page.hit. */
  eventType: string;
  /** Clé tenant telle que fournie par l'app (Notifuse = workspace slug). */
  workspaceSlug: string;
  /** Clé d'idempotence applicative (UUID fourni par l'émetteur). */
  idempotencyKey: string;
  /** Quand l'event s'est produit côté app (ISO8601). */
  occurredAt: string;
  /** Adresse mail du prospect (clé de jointure V1). Optionnel (page.hit anonyme). */
  contactEmail?: string | null;
  /** ID prospect déterministe cross-app (étage 2). Optionnel au V1. */
  vid?: string | null;
  /** Payload brut spécifique à l'event. */
  data?: Record<string, unknown> | null;
}

export interface IngestResult {
  /** True si l'event a été ingéré (1ère fois). False si replay dédupliqué. */
  ingested: boolean;
}

/** Normalise une adresse mail pour la clé de jointure (lowercase + trim). */
function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ingère un event comportemental : INSERT ProspectEvent (idempotent). NE calcule
 * AUCUN score (events ⟂ scoring, cf en-tête) : le scoring est SORTI du Hub
 * (refactor bus 2026-06-17), il vit dans le CRM Twenty de chaque tenant. Il n'y
 * a plus de couche scoring côté Hub — `lib/prospect/scoring` a été supprimé.
 *
 * @throws si la persistance échoue (hors violation d'unique = replay, avalé).
 */
export async function ingestProspectEvent(
  input: IngestEventInput,
): Promise<IngestResult> {
  const contactEmail = normalizeEmail(input.contactEmail);
  const vid = input.vid && input.vid.length > 0 ? input.vid : null;
  // occurred_at peut être absent/invalide selon l'émetteur → fallback NOW
  // (best-effort, jamais d'Invalid Date en DB).
  const parsed = new Date(input.occurredAt);
  const occurredAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const data = (input.data ?? {}) as Prisma.InputJsonValue;

  // Résolution best-effort du tenant Hub (workspace orphelin = NULL, ingéré quand même).
  let tenantUuid: string | null = null;
  try {
    const resolved = await resolveTenantByExternalId(input.app, input.workspaceSlug);
    tenantUuid = resolved?.id ?? null;
  } catch (err) {
    console.warn(
      `[prospect:ingest] tenant resolution failed app=${input.app} slug=${input.workspaceSlug}`,
      err,
    );
  }

  // INSERT idempotent de l'event dans une transaction. Le P2002 (replay) est
  // propagé hors tx via une sentinelle (no-op gracieux : l'event existe déjà).
  const DEDUP = Symbol('prospect-event-dedup');
  try {
    await prisma.$transaction(async (tx) => {
      try {
        await tx.prospectEvent.create({
          data: {
            app: input.app,
            eventType: input.eventType,
            vid,
            workspaceSlug: input.workspaceSlug,
            tenantUuid,
            contactEmail,
            idempotencyKey: input.idempotencyKey,
            occurredAt,
            data,
          },
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'P2002') {
          // Replay : abort la tx (rien à committer) et signale le no-op au caller.
          throw DEDUP;
        }
        throw err;
      }
    });
  } catch (err) {
    if (err === DEDUP) {
      console.info(
        `[prospect:ingest] dedup hit event=${input.eventType} key=${input.idempotencyKey}`,
      );
      return { ingested: false };
    }
    // Toute autre erreur remonte (le caller décide du retry). La tx a rollback.
    throw err;
  }

  return { ingested: true };
}
