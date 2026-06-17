/**
 * Pull Analytics → events comportementaux dans le réconciliateur prospect.
 *
 * Porté du bridge `veridian-tunnel-de-vente/bridge/src/analytics-pull.ts`,
 * adapté au modèle Hub : le bridge accumulait des « jalons digest » dans un
 * store SQLite maison ; le Hub n'a pas de store parallèle — il ingère dans la
 * VRAIE table `prospect_events` via `ingestProspectEvent` (idempotence par
 * `idempotency_key` UNIQUE). Cf docs/CONTRAT-HUB.md §7.5.
 *
 * Séparation events / scoring (archi figée Robert 2026-06-17) : ce module ne
 * fait QUE persister le FLUX d'events Analytics. `ingestProspectEvent` persiste
 * l'event seul, idempotent ; le scoring se calcule plus tard, AILLEURS, par-dessus
 * le flux (couche séparée). On n'a donc aucune attente sur le score ici — on
 * alimente, point.
 *
 * Ce module fait UN passage = pull export.userEvents sur une FENÊTRE FIXE de
 * 48 h (aucun curseur persistant : les `idempotency_key` étant DÉTERMINISTES,
 * re-traiter du déjà-vu coûte zéro écriture — l'idempotence remplace l'état) :
 *   1. pull export Analytics (events identifiés) → agrégats par identité
 *   2. pour chaque identité → émission d'events comportementaux Hub :
 *        - `page.hit` par (identité, path web visité)
 *        - jalons audit (`audit.page_view`/`audit.scroll`/`audit.cta_click`,
 *          `signup`, `app.started`) pour forensics/timeline
 *
 * Idempotence (invariant DoD §6.4) : les `idempotency_key` sont DÉTERMINISTES
 * (`analytics:<identity>:<type>[:<path>]`) → un re-pull complet sur un état
 * convergé produit 0 écriture (P2002 avalé par `ingestProspectEvent`).
 *
 * Jointure prospect (V1 = par email, contrat §7.5) :
 *   - identité = email (`user_id` contient '@') → `contactEmail` renseigné
 *     (l'event est attribuable à un prospect par la couche scoring aval).
 *   - identité = slug anonyme (ex `tramtech-x7k2q1aa`) → `contactEmail` NULL,
 *     `vid` = slug (corrélation étage 2 future) ; events ingérés pour forensics,
 *     non attribuables à un prospect au V1.
 */

import { ingestProspectEvent, type IngestResult } from '@/lib/prospect/ingest';
import type { ExportedEvent } from '@/lib/prospect/engine-client';
import {
  EngineClient,
  engineConfigFromEnv
} from '@/lib/prospect/engine-client';

/** Fenêtre fixe de pull (48 h), identique au bridge. */
export const PULL_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Goal names RÉELS émis par le site (terrain site-audit 2026-06-10) — le mapping
 * vers les jalons audit se fait ICI, le site garde ses noms.
 */
const CTA_GOALS = new Set([
  'audit_cta_rdv',
  'appointment_click',
  'roi_lead_click',
  'cta_click'
]);
const RDV_GOALS = new Set(['rdv_booked']);
const CONSENT_GOALS = new Set(['consent_granted']);
const AUDIT_VIEW_GOALS = new Set(['audit_view', 'audit_page_view']);
const AUDIT_SCROLL_GOALS = new Set(['audit_scroll', 'scroll_depth']);
/** Goals émis par le HUB (contrat events Hub figé 2026-06-11). */
const SIGNUP_GOALS = new Set(['signup']);
const APP_STARTED_GOALS = new Set(['app_started']);
/**
 * Whitelist des `properties.app` qui valent le jalon `app.started` (contrat
 * §4a-bis). Seules les vraies apps SaaS Hub comptent. `roi-calculator` (source
 * site) est EXCLU — déjà couvert par HOT_PAGE(/roi) + CTA.
 */
const APP_STARTED_SCORED_APPS = new Set(['notifuse', 'prospection']);

/** Jalon audit déterministe → eventType Hub (ingéré pour forensics/timeline). */
export const MILESTONE_EVENT_TYPES = {
  'audit.page_view': 'audit.page_view',
  'audit.scroll': 'audit.scroll',
  'audit.cta_click': 'audit.cta_click',
  'audit.rdv': 'audit.rdv',
  signup: 'signup',
  'app.started': 'app.started'
} as const;

export type MilestoneType = keyof typeof MILESTONE_EVENT_TYPES;

/** Agrégat d'une identité sur la fenêtre : jalons atteints + pages web hit. */
export interface IdentityAggregate {
  /** Identité brute de l'export (email OU slug). */
  identity: string;
  /** True si l'identité est un email (jointure prospect possible). */
  isEmail: boolean;
  /** Jalons audit atteints → ISO timestamp du 1er franchissement. */
  milestones: Map<MilestoneType, string>;
  /** Pages web vues (screen_view hors /audit/) → ISO timestamp 1er hit. */
  pageHits: Map<string, string>;
}

/**
 * Agrège les events bruts par identité (sémantique SCORING-V1 §3, portée du
 * bridge). Produit les jalons audit et la liste des pages web hit. PURE.
 */
export function aggregateEvents(
  events: ExportedEvent[],
  previous?: Map<string, IdentityAggregate>
): Map<string, IdentityAggregate> {
  const out = previous ?? new Map<string, IdentityAggregate>();

  for (const e of events) {
    const id = e.user_id;
    if (!id) continue;
    let entry = out.get(id);
    if (!entry) {
      entry = {
        identity: id,
        isEmail: id.includes('@'),
        milestones: new Map(),
        pageHits: new Map()
      };
      out.set(id, entry);
    }
    const eventTime = e.goal_timestamp ?? e.updated_at;

    if (e.name === 'screen_view') {
      if (e.path.startsWith('/audit/')) {
        setMilestone(entry, 'audit.page_view', eventTime);
        if (e.max_scroll >= 75) setMilestone(entry, 'audit.scroll', eventTime);
      } else {
        // Toute page web hors /audit/ = un signal de visite (page.hit). On garde
        // le 1er timestamp par path → idempotency_key déterministe par page
        // (re-pull de la même page = dédup, nouvelle page = nouvel event). La
        // pondération par page « chaude » (/tarifs, /roi…) est une feature de la
        // couche scoring aval (étage 2, corrélation vid) — pas notre affaire ici.
        if (!entry.pageHits.has(e.path)) {
          entry.pageHits.set(e.path, toIso(eventTime));
        }
      }
    } else if (e.name === 'goal') {
      if (AUDIT_VIEW_GOALS.has(e.goal_name)) {
        setMilestone(entry, 'audit.page_view', eventTime);
      } else if (AUDIT_SCROLL_GOALS.has(e.goal_name)) {
        const depth = Number(e.properties?.depth ?? 0);
        if (depth >= 75) setMilestone(entry, 'audit.scroll', eventTime);
      } else if (CTA_GOALS.has(e.goal_name)) {
        setMilestone(entry, 'audit.cta_click', eventTime);
      } else if (RDV_GOALS.has(e.goal_name)) {
        setMilestone(entry, 'audit.rdv', eventTime);
      } else if (CONSENT_GOALS.has(e.goal_name)) {
        // tracké côté engine, ne produit AUCUN jalon scorant (décision lead).
      } else if (SIGNUP_GOALS.has(e.goal_name)) {
        setMilestone(entry, 'signup', eventTime);
      } else if (APP_STARTED_GOALS.has(e.goal_name)) {
        if (APP_STARTED_SCORED_APPS.has(String(e.properties?.app ?? ''))) {
          setMilestone(entry, 'app.started', eventTime);
        }
      }
      // goal inconnu : ignoré ici (reste capturé côté engine).
    }
  }
  return out;
}

function setMilestone(
  entry: IdentityAggregate,
  type: MilestoneType,
  isoTime: string
): void {
  if (!entry.milestones.has(type)) entry.milestones.set(type, toIso(isoTime));
}

/** Résumé d'un run de pull (renvoyé par la route cron pour audit). */
export interface PullSummary {
  /** Events bruts lus depuis l'export. */
  pulled: number;
  /** Identités distinctes agrégées. */
  identities: number;
  /** Appels `ingestProspectEvent` émis (jalons + page.hit). */
  emitted: number;
  /** Events réellement ingérés (1ère fois — re-pull convergé = 0). */
  ingested: number;
  /**
   * Events attribuables à un prospect (identité = email → contactEmail rempli).
   * Métrique de notre flux, indépendante de la couche scoring aval (events et
   * scoring sont découplés — archi 2026-06-17).
   */
  attributable: number;
  /** Identités sautées faute de credentials engine. */
  skipped: boolean;
  /** Fenêtre pull [since, until] en ISO. */
  since: string;
  until: string;
  /** Durée du run en ms. */
  durationMs: number;
}

/** Dépendances injectables (testabilité — pas d'I/O caché). */
export interface PullDeps {
  engine: Pick<EngineClient, 'isConfigured' | 'exportAll'>;
  /** Le point d'entrée d'ingestion (par défaut le vrai `ingestProspectEvent`). */
  ingest?: typeof ingestProspectEvent;
  /** Slug tenant Analytics (workspace) — clé tenant côté Hub. */
  workspaceSlug: string;
  /** Horloge injectable (défaut Date.now). */
  now?: () => Date;
}

/**
 * UN passage de pull Analytics : export 48 h → agrégats → ingestion des events
 * comportementaux Hub (page.hit + jalons audit). Idempotent par construction.
 */
export async function pullAnalytics(deps: PullDeps): Promise<PullSummary> {
  const ingest = deps.ingest ?? ingestProspectEvent;
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - PULL_WINDOW_MS).toISOString();
  const until = now.toISOString();
  const startedAt = Date.now();

  const empty: PullSummary = {
    pulled: 0,
    identities: 0,
    emitted: 0,
    ingested: 0,
    attributable: 0,
    skipped: false,
    since,
    until,
    durationMs: 0
  };

  if (!deps.engine.isConfigured()) {
    return { ...empty, skipped: true, durationMs: Date.now() - startedAt };
  }

  // 1. Pull + agrégation sur la fenêtre fixe.
  const aggregates = new Map<string, IdentityAggregate>();
  let pulled = 0;
  for await (const page of deps.engine.exportAll(since, until)) {
    pulled += page.length;
    aggregateEvents(page, aggregates);
  }

  // 2. Émission des events comportementaux Hub (idempotent par idempotency_key).
  let emitted = 0;
  let ingested = 0;
  let attributable = 0;
  for (const entry of Array.from(aggregates.values())) {
    const results = await emitForIdentity(entry, deps.workspaceSlug, ingest);
    for (const r of results) {
      emitted += 1;
      if (r.ingested) ingested += 1;
      // Attribuable = émis pour une identité email (contactEmail rempli) —
      // métrique de notre flux, pas du scoring (découplés).
      if (entry.isEmail) attributable += 1;
    }
  }

  return {
    pulled,
    identities: aggregates.size,
    emitted,
    ingested,
    attributable,
    skipped: false,
    since,
    until,
    durationMs: Date.now() - startedAt
  };
}

/**
 * Émet, pour une identité, ses jalons audit + page.hit en events Hub.
 * - email → contactEmail renseigné (event attribuable au prospect), vid NULL.
 * - slug  → contactEmail NULL (anonyme, forensics), vid = slug (corrélation
 *   étage 2 future).
 * Chaque appel a un `idempotencyKey` déterministe → re-pull = dédup (0 doublon).
 * Le score n'est PAS calculé ici (couche aval découplée — archi 2026-06-17).
 */
async function emitForIdentity(
  entry: IdentityAggregate,
  workspaceSlug: string,
  ingest: typeof ingestProspectEvent
): Promise<IngestResult[]> {
  const contactEmail = entry.isEmail ? entry.identity : null;
  const vid = entry.isEmail ? null : entry.identity;
  const results: IngestResult[] = [];

  // Jalons audit (forensics/timeline). Persistés tels quels — le scoring aval
  // décide quoi en faire.
  for (const [milestone, occurredAt] of Array.from(entry.milestones)) {
    results.push(
      await ingest({
        app: 'analytics',
        eventType: MILESTONE_EVENT_TYPES[milestone],
        workspaceSlug,
        idempotencyKey: `analytics:${entry.identity}:${milestone}`,
        occurredAt,
        contactEmail,
        vid,
        data: { milestone, source: 'analytics-pull' }
      })
    );
  }

  // page.hit par page web visitée (attribuable au prospect si identité = email).
  for (const [path, occurredAt] of Array.from(entry.pageHits)) {
    results.push(
      await ingest({
        app: 'analytics',
        eventType: 'page.hit',
        workspaceSlug,
        idempotencyKey: `analytics:${entry.identity}:page.hit:${path}`,
        occurredAt,
        contactEmail,
        vid,
        data: { path, source: 'analytics-pull' }
      })
    );
  }

  return results;
}

/** Construit un EngineClient + le slug workspace depuis l'ENV. */
export function pullDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PullDeps {
  const config = engineConfigFromEnv(env);
  return {
    engine: new EngineClient(config),
    workspaceSlug: config.workspaceId
  };
}

/** "2026-06-10 11:36:52.498" (ClickHouse) ou ISO → ISO8601. */
function toIso(s: string): string {
  return parseClickHouseDate(s)?.toISOString() ?? new Date().toISOString();
}

function parseClickHouseDate(s: string): Date | null {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
