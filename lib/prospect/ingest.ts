/**
 * Ingestion d'un event COMPORTEMENTAL dans le réconciliateur prospect.
 *
 * Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
 * Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
 * Standard : docs/CONTRAT-HUB.md §7.5.
 *
 * Point d'entrée UNIQUE appelé par les DEUX voies de transport :
 *   - LEGACY HMAC  (app/api/webhooks/notifuse/route.ts → dispatchLegacyEvent) :
 *     c'est par là que le fork Notifuse ÉMETTRA les events comportementaux une
 *     fois le ticket notifuse-veridian/todo/2026-06-17-emettre-events-
 *     comportementaux-email-opened-clicked-replied-hub.md livré. AUJOURD'HUI les
 *     events open/click sont captifs dans la DB Notifuse et ne sont JAMAIS
 *     .Emit() vers le Hub — ce point d'entrée est donc prêt mais pas encore
 *     alimenté en events comportementaux. (X-Veridian-Notifuse-Signature,
 *     canonical `${ts}.${rawBody}`, payload {event_id, event_type, tenant_id,
 *     occurred_at, data}).
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
 * Atomicité event↔score (fix 2026-06-17) : l'INSERT event et le mouvement du
 * score vivent dans une MÊME `prisma.$transaction`. Si le score échoue, l'event
 * est rollback → le retry re-tente les DEUX et finit par appliquer le score (le
 * bug précédent committait l'event seul, puis le retry était avalé en P2002 →
 * score perdu silencieusement). Le mouvement du score est fait en SQL atomique
 * (`INSERT ... ON CONFLICT DO UPDATE` avec `engagement_score + points` et un
 * `jsonb_set` incrémental sur `signals`) → plus de read-modify-write applicatif,
 * donc `signals` ne diverge plus de `engagement_score` sous events concurrents
 * sur un même (workspace, email).
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

  // Scoring synchrone — l'event n'est scoré que s'il est scorable ET joint à un
  // prospect (contactEmail au V1). page.hit sans email ne peut pas être attribué
  // à un prospect au V1 (le vid en étage 2 lèvera ça).
  const points = scoreForEvent(input.eventType);
  const scorable = points > 0 && !!contactEmail;
  // Clé de signal à incrémenter ({opened|clicked|replied|page_hit}). On la dérive
  // de bumpSignals (source de vérité unique du mapping eventType→clé) plutôt que
  // de la dupliquer ici. `bumpSignals({}, type)` renvoie `{ <clé>: 1 }`.
  const signalKey = scorable
    ? (Object.keys(bumpSignals(null, input.eventType))[0] ?? null)
    : null;

  // INSERT event + mouvement du score dans une MÊME transaction : si le score
  // échoue, l'event est rollback → le retry re-tente les deux. Le P2002 (replay)
  // est propagé hors tx via une sentinelle pour rester un no-op gracieux (l'event
  // existe déjà, on NE re-score PAS — anti double comptage).
  const DEDUP = Symbol('prospect-event-dedup');
  try {
    await prisma.$transaction(async (tx) => {
      // 1. INSERT idempotent de l'event. Violation d'unique = replay → abort tx.
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

      // 2. Mouvement du score, SQL atomique dans la MÊME tx — seulement si scorable.
      //    `engagement_score + points` et `jsonb_set` incrémental sur `signals`
      //    se font côté DB → pas de read-modify-write applicatif, donc signals ne
      //    diverge plus du score sous events concurrents sur un même (ws,email).
      if (!scorable || !signalKey) return;

      // last_event_at = greatest(existant, occurredAt) — un event out-of-order
      // ne doit pas faire régresser l'horodatage du dernier event vu.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO hub_app.prospect_scores
          (id, workspace_slug, contact_email, vid, tenant_uuid,
           engagement_score, last_event_at, signals, created_at, updated_at)
        VALUES (
          gen_random_uuid(), ${input.workspaceSlug}, ${contactEmail}, ${vid},
          ${tenantUuid}::uuid, ${points}, ${occurredAt},
          jsonb_build_object(${signalKey}::text, 1), now(), now()
        )
        ON CONFLICT (workspace_slug, contact_email) DO UPDATE SET
          engagement_score = hub_app.prospect_scores.engagement_score + ${points},
          last_event_at = GREATEST(
            COALESCE(hub_app.prospect_scores.last_event_at, ${occurredAt}::timestamptz),
            ${occurredAt}::timestamptz
          ),
          signals = jsonb_set(
            COALESCE(hub_app.prospect_scores.signals, '{}'::jsonb),
            ARRAY[${signalKey}::text],
            to_jsonb(
              COALESCE((hub_app.prospect_scores.signals ->> ${signalKey})::int, 0) + 1
            ),
            true
          ),
          -- Backfill du vid / tenant_uuid si on les apprend après coup (étage 2).
          vid = COALESCE(${vid}, hub_app.prospect_scores.vid),
          tenant_uuid = COALESCE(${tenantUuid}::uuid, hub_app.prospect_scores.tenant_uuid),
          updated_at = now()
      `);
    });
  } catch (err) {
    if (err === DEDUP) {
      console.info(
        `[prospect:ingest] dedup hit event=${input.eventType} key=${input.idempotencyKey}`,
      );
      return { ingested: false, scored: false, points: 0 };
    }
    // Toute autre erreur remonte (le caller décide du retry). La tx a rollback :
    // ni l'event ni le score n'ont été committés → le retry re-tente les deux.
    throw err;
  }

  if (!scorable) {
    return { ingested: true, scored: false, points: 0 };
  }
  return { ingested: true, scored: true, points };
}
