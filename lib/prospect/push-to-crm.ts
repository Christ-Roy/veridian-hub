/**
 * Couche PUSH CRM du réconciliateur prospect — le MAILLON CENTRAL de la chaîne
 * découplée `events → scoring → écriture → CRM`.
 *
 * Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
 * Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
 * Parité : veridian-tunnel-de-vente/bridge/src/writer.ts (séquence Twenty).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ EVENTS ⟂ SCORING — DÉCOUPLÉS (archi tranchée Robert 2026-06-17).          │
 * │                                                                           │
 * │ L'ingestion (`lib/prospect/ingest.ts`) NE calcule AUCUN score : elle      │
 * │ persiste l'event, point. CE module est la couche AVAL, appelée À LA       │
 * │ DEMANDE par le cron `push-prospect-scores` (tick horaire). Pour chaque    │
 * │ prospect ayant des events :                                               │
 * │   1. RELIRE ses events agrégés (prospect_events).                         │
 * │   2. RECALCULER le score FROM-SCRATCH via un `ScoringEngine` pluggable    │
 * │      (`getScoringEngine(id)` — défaut 'tunnel-v2', id lu en ENV pour       │
 * │      rester découplé du moteur).                                          │
 * │   3. ÉCRIRE le score dans prospect_scores (engagement_score, label,       │
 * │      disqualified, components, signals, last_event_at).                   │
 * │   4. ROUTER multitenant : tenant_uuid → CrmTenant → TwentyWriteContext.   │
 * │   5. PUSHER au CRM (lib/crm L2) : resolve Person → batchTimeline →        │
 * │      patchPerson({score}) → doNotContact si disqualif → opportunity       │
 * │      NEW→SCREENING (jamais de recul).                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * IDEMPOTENCE SORTANTE (critique — invariant anti-spam CRM) : le score est
 * TOUJOURS recalculé et réécrit en DB (étape 3, cheap, idempotent), mais le
 * push CRM (étape 5, coûteux + budget Twenty) n'a lieu QUE si le score a CHANGÉ
 * depuis le dernier push (`crm_pushed_score !== engagement_score`). Sinon le
 * cron spammerait Twenty à chaque tick. Après un push RÉEL réussi, on mémorise
 * `crm_pushed_score = engagement_score` + `crm_pushed_at = now`.
 *
 * DRY_RUN (défaut en phase bascule) : le CrmClient est instancié `dryRun:true`
 * (ENV CRON_PUSH_DRY_RUN, défaut true). Les MUTATIONS Twenty sont LOGUÉES, pas
 * envoyées (les LECTURES restent réelles). En DRY_RUN on NE met PAS à jour
 * `crm_pushed_*` (rien n'a été réellement poussé) — l'idempotence sortante ne
 * « consomme » que les vrais pushes, et la bascule en mode réel re-poussera tout.
 *
 * 0 CrmTenant : au 2026-06-17 il y a 0 CrmTenant actif en prod. Un prospect dont
 * le tenant n'a pas de workspace CRM résolu est SKIPPÉ gracieusement (score
 * quand même écrit en DB — étape 3 — mais pas de push). Le code est
 * multitenant-ready : il tournera dès qu'un CrmTenant existera, sans changement.
 */

import type { PrismaClient } from '@prisma/client';

import { CrmClient, createCrmClientFromEnv } from '@/lib/crm/client';
import { getCrmTenantById, getCrmTenantByUserId } from '@/lib/crm/select-tenant';
import type { TimelineActivityInput, TwentyWriteContext } from '@/lib/crm/types';
import { decryptSecret } from '@/lib/crm/vault';
import { prisma as defaultPrisma } from '@/lib/prisma';
import {
  type AggregableEvent,
  aggregateSignals,
  DEFAULT_SCORING_ENGINE_ID,
  getScoringEngine,
  type ProspectScoreResult,
  type ScoringEngine,
} from '@/lib/prospect/scoring';

/** Stage Twenty cible quand un email a été envoyé (NEW→SCREENING, §4c.6). */
const SCREENING_STAGE = 'SCREENING';
/** Stage de départ d'une opportunity (import batch). On n'avance que depuis là. */
const NEW_STAGE = 'NEW';
/** Plafond d'items timeline par batch (contrat §4c.2 — le client re-vérifie). */
const TIMELINE_BATCH_MAX = 60;

/**
 * Un prospect candidat au push : sa clé (workspace, email) + ses events relus.
 * `tenantUuid` route vers le CrmTenant (peut être null = workspace orphelin).
 */
export interface ProspectCandidate {
  workspaceSlug: string;
  contactEmail: string;
  tenantUuid: string | null;
  vid: string | null;
  events: AggregableEvent[];
}

/** Issue du traitement d'UN prospect (pour le summary agrégé). */
export type ProspectOutcome =
  | 'pushed' // score poussé au CRM (mutation réelle ou loguée DRY_RUN)
  | 'unchanged' // score recalculé identique au dernier push → pas de re-push
  | 'no_crm_tenant' // pas de workspace CRM pour ce tenant → score écrit, push skip
  | 'person_not_found' // Person introuvable dans le CRM → orphan (re-tenté)
  | 'error'; // échec push (budget Twenty, réseau) → row reste, re-tentée

export interface PushSummary {
  /** Prospects candidats examinés. */
  candidates: number;
  /** Scores recalculés + écrits en DB (toujours = candidates). */
  scored: number;
  /** Prospects réellement poussés au CRM (score changé). */
  pushed: number;
  /** Score inchangé depuis le dernier push → push évité (idempotence sortante). */
  unchanged: number;
  /** Prospects sans CrmTenant → push skippé (score quand même écrit). */
  noCrmTenant: number;
  /** Person introuvable côté CRM → orphan. */
  personNotFound: number;
  /** Échecs de push (re-tentés au prochain tick). */
  errors: number;
  /** True si le run a tourné en DRY_RUN (mutations loguées, pas envoyées). */
  dryRun: boolean;
  /** Id du moteur de scoring appliqué (traçabilité). */
  engineId: string;
  durationMs: number;
}

/** Dépendances injectables (testabilité — aucun I/O caché). */
export interface PushDeps {
  prisma?: PrismaClient;
  /** Le CrmClient (DI pour tests). Par défaut construit depuis l'ENV. */
  crmClient?: CrmClient;
  /** Moteur de scoring à appliquer. Par défaut résolu depuis `engineId`. */
  engine?: ScoringEngine;
  /** Id moteur (lu en ENV par la factory). Ignoré si `engine` fourni. */
  engineId?: string;
  /** DRY_RUN du push CRM (mutations loguées). Défaut : true (phase bascule). */
  dryRun?: boolean;
  /** Plafond de prospects traités par run (clamp anti-abus). Défaut 500. */
  limit?: number;
  /** Horloge injectable (récence scoring + crm_pushed_at). Défaut Date. */
  now?: () => Date;
}

/**
 * UN passage du push : lit les prospects ayant des events, (re)calcule leur
 * score, l'écrit en DB, et pousse au CRM ceux dont le score a changé. Idempotent
 * (idempotence sortante via crm_pushed_score). Voir l'en-tête pour la séquence.
 */
export async function pushProspectScores(deps: PushDeps = {}): Promise<PushSummary> {
  const prisma = deps.prisma ?? defaultPrisma;
  const now = (deps.now ?? (() => new Date()))();
  const startedAt = Date.now();
  const dryRun = deps.dryRun ?? true;
  const limit = clampLimit(deps.limit);
  const engine = deps.engine ?? getScoringEngine(deps.engineId ?? DEFAULT_SCORING_ENGINE_ID);
  const crmClient = deps.crmClient ?? createCrmClientFromEnv({ dryRun });

  // Token bucket Twenty partagé entre tenants : reset en début de run.
  crmClient.resetWriteBudget();

  const candidates = await loadCandidates(prisma, limit);

  const summary: PushSummary = {
    candidates: candidates.length,
    scored: 0,
    pushed: 0,
    unchanged: 0,
    noCrmTenant: 0,
    personNotFound: 0,
    errors: 0,
    dryRun,
    engineId: engine.id,
    durationMs: 0,
  };

  // Cache de résolution CrmTenant par tenant_uuid (1 résolution par tenant /
  // run, même si N prospects partagent le tenant). `null` = résolu absent.
  const ctxByTenant = new Map<string, TenantWriteResolution | null>();

  for (const candidate of candidates) {
    const signals = aggregateSignals(candidate.contactEmail, candidate.events);
    const result = engine.compute(signals, now);

    // Étape 3 — TOUJOURS écrire le score (cheap, idempotent, découplé du push).
    await writeScore(prisma, candidate, result);
    summary.scored += 1;

    // Étape 4 — router multitenant (skip gracieux si pas de CrmTenant).
    const resolution = await resolveTenantWrite(prisma, candidate.tenantUuid, ctxByTenant);
    if (!resolution) {
      summary.noCrmTenant += 1;
      continue;
    }

    // Idempotence SORTANTE : push CRM seulement si le score a changé.
    const stored = await prisma.prospectScore.findUnique({
      where: {
        workspaceSlug_contactEmail: {
          workspaceSlug: candidate.workspaceSlug,
          contactEmail: candidate.contactEmail,
        },
      },
      select: { crmPushedScore: true },
    });
    if (stored && stored.crmPushedScore === result.score) {
      summary.unchanged += 1;
      continue;
    }

    // Étape 5 — push CRM (séquence parité bridge).
    const outcome = await pushToCrm(crmClient, resolution.ctx, candidate, result, { dryRun });
    switch (outcome) {
      case 'pushed':
        summary.pushed += 1;
        // En DRY_RUN rien n'a été réellement envoyé → on NE marque PAS le push
        // (l'idempotence sortante ne consomme que les vrais pushes).
        if (!dryRun) {
          await markPushed(prisma, candidate, result.score, now);
        }
        break;
      case 'person_not_found':
        summary.personNotFound += 1;
        break;
      case 'error':
        summary.errors += 1;
        break;
      default:
        break;
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

// ─── Étapes internes ────────────────────────────────────────────────────────

/** Résolution d'écriture pour un tenant : contexte Twenty prêt à l'emploi. */
interface TenantWriteResolution {
  ctx: TwentyWriteContext;
}

/**
 * Charge les prospects candidats : tous les `(workspace_slug, contact_email)`
 * distincts ayant au moins un event attribuable (contact_email non NULL), avec
 * leurs events relus. Les events anonymes (contact_email NULL) ne sont pas
 * attribuables à un prospect au V1 → ignorés ici (forensics seulement).
 */
async function loadCandidates(
  prisma: PrismaClient,
  limit: number,
): Promise<ProspectCandidate[]> {
  // 1. Clés prospect distinctes (workspace, email) — bornées par `limit`.
  // `orderBy` requis par Prisma dès qu'on passe `take` (et rend le run
  // déterministe : on traite toujours les mêmes prospects en tête de liste).
  const keys = await prisma.prospectEvent.groupBy({
    by: ['workspaceSlug', 'contactEmail'],
    where: { contactEmail: { not: null } },
    orderBy: [{ workspaceSlug: 'asc' }, { contactEmail: 'asc' }],
    take: limit,
  });

  const candidates: ProspectCandidate[] = [];
  for (const key of keys) {
    const contactEmail = key.contactEmail;
    if (!contactEmail) continue;
    const rows = await prisma.prospectEvent.findMany({
      where: { workspaceSlug: key.workspaceSlug, contactEmail },
      select: { eventType: true, occurredAt: true, data: true, tenantUuid: true, vid: true },
      orderBy: { occurredAt: 'asc' },
    });
    if (rows.length === 0) continue;
    // tenant_uuid / vid : pris sur la 1re row qui les porte (cohérents par
    // prospect — un même email d'un même workspace = un même tenant).
    const tenantUuid = rows.find((r) => r.tenantUuid)?.tenantUuid ?? null;
    const vid = rows.find((r) => r.vid)?.vid ?? null;
    candidates.push({
      workspaceSlug: key.workspaceSlug,
      contactEmail,
      tenantUuid,
      vid,
      events: rows.map((r) => ({
        eventType: r.eventType,
        occurredAt: r.occurredAt,
        data: r.data as Record<string, unknown> | null,
      })),
    });
  }
  return candidates;
}

/**
 * Écrit (upsert) le score recalculé dans prospect_scores. TOUJOURS exécuté
 * (découplé du push CRM). `signals` = compteurs résumés dérivés des components.
 */
async function writeScore(
  prisma: PrismaClient,
  candidate: ProspectCandidate,
  result: ProspectScoreResult,
): Promise<void> {
  const signals = signalsFromComponents(result.components);
  await prisma.prospectScore.upsert({
    where: {
      workspaceSlug_contactEmail: {
        workspaceSlug: candidate.workspaceSlug,
        contactEmail: candidate.contactEmail,
      },
    },
    create: {
      workspaceSlug: candidate.workspaceSlug,
      contactEmail: candidate.contactEmail,
      vid: candidate.vid,
      tenantUuid: candidate.tenantUuid,
      engagementScore: result.score,
      label: result.label,
      disqualified: result.disqualified,
      lastEventAt: result.lastSignalAt,
      components: result.components,
      signals,
    },
    update: {
      vid: candidate.vid,
      tenantUuid: candidate.tenantUuid,
      engagementScore: result.score,
      label: result.label,
      disqualified: result.disqualified,
      lastEventAt: result.lastSignalAt,
      components: result.components,
      signals,
    },
  });
}

/** Marque un push CRM réussi (idempotence sortante) — jamais en DRY_RUN. */
async function markPushed(
  prisma: PrismaClient,
  candidate: ProspectCandidate,
  score: number,
  now: Date,
): Promise<void> {
  await prisma.prospectScore.update({
    where: {
      workspaceSlug_contactEmail: {
        workspaceSlug: candidate.workspaceSlug,
        contactEmail: candidate.contactEmail,
      },
    },
    data: { crmPushedScore: score, crmPushedAt: now },
  });
}

/**
 * Résout le contexte d'écriture Twenty pour un tenant (caché par run).
 *
 * Pont d'identité (3 maillons — chacun manquant = skip gracieux) :
 *   prospect_events.tenant_uuid → Tenant.id
 *   Tenant.user_id (uuid bridge) = User.supabase_user_id
 *   User.id (cuid) = crm_tenants.user_id  → getCrmTenantByUserId
 *
 * `tenants.user_id` et `crm_tenants.user_id` vivent dans deux espaces d'ID
 * différents (uuid bridge vs cuid Auth.js) — d'où le passage par `users`. Le
 * Bearer Twenty est déchiffré du vault (CRM_VAULT_KEY) au moment de l'usage.
 *
 * Retourne `null` (et le mémorise) si l'un des maillons manque ou si le tenant
 * n'a pas de CrmTenant actif (cas nominal au 2026-06-17 : 0 CrmTenant en prod).
 */
async function resolveTenantWrite(
  prisma: PrismaClient,
  tenantUuid: string | null,
  cache: Map<string, TenantWriteResolution | null>,
): Promise<TenantWriteResolution | null> {
  if (!tenantUuid) return null;
  if (cache.has(tenantUuid)) return cache.get(tenantUuid) ?? null;

  const resolution = await resolveTenantWriteUncached(prisma, tenantUuid);
  cache.set(tenantUuid, resolution);
  return resolution;
}

async function resolveTenantWriteUncached(
  prisma: PrismaClient,
  tenantUuid: string,
): Promise<TenantWriteResolution | null> {
  // Maillon 1 : tenant_uuid → Tenant → user_id (uuid bridge).
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantUuid },
    select: { userId: true },
  });
  if (!tenant?.userId) return null;

  // Maillon 2 : user_id (uuid bridge) → User.id (cuid) via supabase_user_id.
  const user = await prisma.user.findUnique({
    where: { supabaseUserId: tenant.userId },
    select: { id: true },
  });
  if (!user?.id) return null;

  // Maillon 3 : User.id → CrmTenant actif. SafeView (sans secrets) pour le
  // statut, puis row brute pour déchiffrer le Bearer.
  const safe = await getCrmTenantByUserId(user.id, prisma);
  if (!safe || safe.status !== 'active') return null;
  const row = await getCrmTenantById(safe.id, prisma);
  if (!row) return null;

  let bearer: string;
  try {
    bearer = decryptSecret(row.twentyApiKeyEncrypted);
  } catch (err) {
    console.error(
      `[prospect:push] déchiffrement Bearer CRM échoué tenant=${tenantUuid}`,
      err,
    );
    return null;
  }

  return { ctx: { baseUrl: row.twentyWorkspaceUrl, bearer } };
}

/**
 * Pousse un prospect au CRM (séquence parité bridge §4c) :
 *   resolve Person (email) → batchTimeline(jalons) → patchPerson({score})
 *   → si disqualified patchPerson({doNotContact}) → opportunity NEW→SCREENING.
 *
 * Person introuvable → 'person_not_found' (orphan, re-tenté). Toute erreur
 * (budget Twenty épuisé, réseau) → 'error' : la row n'est PAS marquée poussée,
 * elle repassera au prochain tick.
 */
async function pushToCrm(
  crmClient: CrmClient,
  ctx: TwentyWriteContext,
  candidate: ProspectCandidate,
  result: ProspectScoreResult,
  opts: { dryRun: boolean },
): Promise<ProspectOutcome> {
  try {
    const person = await crmClient.resolvePersonCached(ctx, candidate.contactEmail);
    if (!person) return 'person_not_found';

    // Jalons timeline (digests §4c.3 — jamais le flux brut). Un item par event
    // scorant, plafonné au batch max (les events au-delà partiront au prochain
    // tick — extrêmement rare, un prospect a < 60 events significatifs).
    const items = timelineItems(person.id, candidate);
    if (items.length > 0) {
      await crmClient.batchTimeline(ctx, items.slice(0, TIMELINE_BATCH_MAX), opts);
    }

    // Score (§4c.4) — la valeur recalculée from-scratch.
    await crmClient.patchPerson(ctx, person.id, { score: result.score }, opts);

    // Disqualif (§4c.5) — bounce dur / opt-out → doNotContact.
    if (result.disqualified) {
      await crmClient.patchPerson(ctx, person.id, { doNotContact: true }, opts);
    }

    // Stage NEW→SCREENING (§4c.6) — read-then-patch, jamais de recul. Déclenché
    // par la présence d'un email.sent dans l'historique du prospect.
    if (hasEmailSent(candidate.events)) {
      const opp = await crmClient.opportunityForPerson(ctx, person.id);
      if (opp && opp.stage === NEW_STAGE) {
        await crmClient.patchOpportunityStage(ctx, opp.id, SCREENING_STAGE, opts);
      }
    }

    return 'pushed';
  } catch (err) {
    console.error(
      `[prospect:push] push CRM échoué email=${candidate.contactEmail} ws=${candidate.workspaceSlug}`,
      err,
    );
    return 'error';
  }
}

// ─── Helpers purs ───────────────────────────────────────────────────────────

/** Construit les timeline activities (digests) d'un prospect. */
function timelineItems(
  personId: string,
  candidate: ProspectCandidate,
): TimelineActivityInput[] {
  const items: TimelineActivityInput[] = [];
  for (const ev of candidate.events) {
    items.push({
      name: ev.eventType,
      happensAt: toIso(ev.occurredAt),
      targetPersonId: personId,
      properties: {
        source: 'prospect-reconciler',
        eventType: ev.eventType,
        ...(candidate.vid ? { vid: candidate.vid } : {}),
      },
    });
  }
  return items;
}

/** True si le prospect a au moins un email.sent (déclencheur SCREENING). */
function hasEmailSent(events: readonly AggregableEvent[]): boolean {
  return events.some((e) => e.eventType === 'email.sent');
}

/**
 * Compteurs résumés par signal pour la timeline / dashboard, dérivés des mêmes
 * `components` (jamais de dérive). Les clés components (`email_clicks`,
 * `identify_email`, …) sont reprises telles quelles — `signals` est une vue
 * compacte du même calcul.
 */
function signalsFromComponents(components: Record<string, number>): Record<string, number> {
  // Vue plate des points par composant (hors multiplicateur de récence qui
  // n'est pas un "signal" mais un facteur). Le score n'est pas une boîte noire.
  const signals: Record<string, number> = {};
  for (const [k, v] of Object.entries(components)) {
    if (k === 'recency_multiplier') continue;
    signals[k] = v;
  }
  return signals;
}

/** Normalise une date (Date | string) en ISO UTC pour Twenty. */
function toIso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Clamp du `limit` (1..500, défaut 500). */
function clampLimit(raw: number | undefined): number {
  const n = Number(raw ?? 500);
  if (!Number.isFinite(n) || n < 1) return 500;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

/**
 * Construit les dépendances du push depuis l'ENV (DRY_RUN, moteur). Le
 * CrmClient est laissé à la factory par défaut (construit lui-même depuis les
 * ENV CRM_*). Appelé par la route cron.
 */
export function pushDepsFromEnv(env: NodeJS.ProcessEnv = process.env): PushDeps {
  // DRY_RUN par défaut TRUE en phase bascule : seul `CRON_PUSH_DRY_RUN=false`
  // (string exacte) active les vraies mutations Twenty.
  const dryRun = env.CRON_PUSH_DRY_RUN !== 'false';
  const engineId = env.PROSPECT_SCORING_ENGINE_ID || DEFAULT_SCORING_ENGINE_ID;
  return { dryRun, engineId };
}
