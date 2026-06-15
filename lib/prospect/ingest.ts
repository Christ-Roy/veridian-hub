/**
 * Ingestion d'un event COMPORTEMENTAL dans le réconciliateur prospect.
 *
 * Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
 * Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
 * Standard : docs/CONTRAT-HUB.md §7.5.
 *
 * Point d'entrée UNIQUE appelé par les DEUX voies de transport :
 *   - LEGACY HMAC  (app/api/webhooks/notifuse/route.ts → dispatchLegacyEvent) :
 *     c'est par là que le fork Notifuse émet AUJOURD'HUI (X-Veridian-Notifuse-
 *     Signature, canonical `${ts}.${rawBody}`, payload {event_id, event_type,
 *     tenant_id, occurred_at, data}).
 *   - v1.4 BEARER  (lib/webhooks/notifuse-handlers.ts → v14Handlers) : la voie
 *     STANDARD que les futures apps (Analytics page.hit) emprunteront, via
 *     `lib/webhooks/receiver.handleWebhook`.
 *
 * Les deux voies normalisent leur payload en `IngestEventInput` puis appellent
 * `ingestProspectEvent`. Le scoring est synchrone et simple (cf scoring.ts).
 *
 * Idempotence : deux couches.
 *   1. Transport : la dédup webhook (legacy = metadata.notifuse_processed_events ;
 *      v1.4 = PK webhook_dedup) protège la route d'un replay.
 *   2. Ingestion : `prospect_events.idempotency_key` UNIQUE. Si l'INSERT viole
 *      l'unique (replay qui a franchi la couche 1), on AVALE et on NE ré-incrémente
 *      PAS le score (best-effort, jamais de double comptage).
 *
 * Best-effort : une erreur d'ingestion remonte au caller (legacy = log + 500
 * pour retry app ; v1.4 = throw → processed_at NULL → retry app). Mais la
 * résolution du tenant UUID est best-effort interne (workspace orphelin = event
 * ingéré quand même, tenant_uuid NULL, pour forensics).
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { resolveTenantByExternalId } from '@/lib/sync/snapshot-updater';
import { bumpSignals, scoreForEvent } from '@/lib/prospect/scoring';
import type { ProspectSignals } from '@/lib/prospect/scoring';

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
  /** True si le score a été déplacé (event scorable + nouvelle ingestion). */
  scored: boolean;
  /** Points ajoutés au score (0 si event inconnu ou replay). */
  points: number;
}

/** Normalise une adresse mail pour la clé de jointure (lowercase + trim). */
function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ingère un event comportemental : INSERT ProspectEvent (idempotent) +
 * UPSERT ProspectScore (si l'event est scorable et joint à un prospect).
 *
 * @throws si la persistance échoue (hors violation d'unique = replay, avalé).
 */
export async function ingestProspectEvent(
  input: IngestEventInput,
): Promise<IngestResult> {
  const contactEmail = normalizeEmail(input.contactEmail);
  const vid = input.vid && input.vid.length > 0 ? input.vid : null;
  // occurred_at peut être absent/invalide selon l'émetteur (le check legacy ne
  // le valide pas) → fallback NOW (best-effort, jamais d'Invalid Date en DB).
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

  // 1. INSERT idempotent de l'event. Violation d'unique = replay → no-op.
  try {
    await prisma.prospectEvent.create({
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
      // Replay : l'event existe déjà. On NE re-score PAS (best-effort, anti
      // double comptage). On renvoie ingested=false sans erreur.
      console.info(
        `[prospect:ingest] dedup hit event=${input.eventType} key=${input.idempotencyKey}`,
      );
      return { ingested: false, scored: false, points: 0 };
    }
    // Toute autre erreur remonte (le caller décide du retry).
    throw err;
  }

  // 2. Scoring synchrone — seulement si l'event est scorable ET joint à un
  //    prospect (contactEmail au V1). page.hit sans email ne peut pas être
  //    attribué à un prospect au V1 (le vid en étage 2 lèvera ça).
  const points = scoreForEvent(input.eventType);
  if (points === 0 || !contactEmail) {
    return { ingested: true, scored: false, points: 0 };
  }

  // UPSERT atomique du score. Idempotence du score garantie en amont par
  // l'INSERT unique de l'event (on n'arrive ici que sur une 1ère ingestion).
  // Le compteur de signal est incrémenté côté create ET update via une read
  // courte (la concurrence sur un même (workspace,email) est faible ; en cas
  // de course, le pire = un signal légèrement sous-compté, le score reste juste
  // via l'increment atomique).
  const existing = await prisma.prospectScore.findUnique({
    where: {
      workspaceSlug_contactEmail: {
        workspaceSlug: input.workspaceSlug,
        contactEmail,
      },
    },
    select: { signals: true, lastEventAt: true },
  });
  const nextSignals: ProspectSignals = bumpSignals(
    (existing?.signals as ProspectSignals | null) ?? null,
    input.eventType,
  );
  // lastEventAt = max(existant, occurredAt) — un event out-of-order ne doit
  // pas faire RÉGRESSER l'horodatage du dernier event vu.
  const prevLast = existing?.lastEventAt ?? null;
  const nextLastEventAt =
    prevLast && prevLast.getTime() > occurredAt.getTime() ? prevLast : occurredAt;

  await prisma.prospectScore.upsert({
    where: {
      workspaceSlug_contactEmail: {
        workspaceSlug: input.workspaceSlug,
        contactEmail,
      },
    },
    create: {
      workspaceSlug: input.workspaceSlug,
      contactEmail,
      vid,
      tenantUuid,
      engagementScore: points,
      lastEventAt: occurredAt,
      signals: nextSignals as Prisma.InputJsonValue,
    },
    update: {
      // Increment atomique du score (juste même en cas de course).
      engagementScore: { increment: points },
      lastEventAt: nextLastEventAt,
      signals: nextSignals as Prisma.InputJsonValue,
      // Backfill du vid si on l'apprend après coup (étage 2).
      ...(vid ? { vid } : {}),
      ...(tenantUuid ? { tenantUuid } : {}),
    },
  });

  return { ingested: true, scored: true, points };
}
