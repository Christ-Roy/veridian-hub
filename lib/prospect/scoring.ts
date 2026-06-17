/**
 * Couche SCORING du réconciliateur prospect (cold↔web) — DÉCOUPLÉE des events.
 *
 * Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
 * Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
 * Standard : docs/CONTRAT-HUB.md §7.5 (event comportemental uniforme).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ EVENTS ⟂ SCORING — DÉCOUPLÉS (archi tranchée Robert 2026-06-17).          │
 * │                                                                           │
 * │ Le scoring est une couche SÉPARÉE, par-dessus l'ingestion. Tout ici est   │
 * │ PUR (zéro I/O) : on reçoit des signaux DÉJÀ agrégés et on calcule un       │
 * │ score. L'ingestion (`lib/prospect/ingest.ts`) NE dépend PAS de ce module  │
 * │ — elle persiste les events, point. Un job/cron À LA DEMANDE relit les     │
 * │ events d'un prospect, les agrège (`aggregateSignals`) et appelle un       │
 * │ `ScoringEngine` (recompute FROM-SCRATCH). JAMAIS de score à l'ingestion.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ MOTEUR PLUGGABLE — `ScoringEngine` (Robert 2026-06-17 : "chacun son       │
 * │ scoring engine").                                                         │
 * │                                                                           │
 * │ Le barème tunnel n'est qu'UN moteur parmi d'autres. L'interface           │
 * │ `ScoringEngine { id, compute(signals, now) }` abstrait le calcul ; le     │
 * │ barème porté du bridge est l'implémentation `tunnelScoringEngine`         │
 * │ (premier moteur du registre `SCORING_ENGINES`). Ajouter un moteur =       │
 * │ implémenter l'interface + l'enregistrer, sans toucher au reste.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * `computeProspectScore(notifuse, analytics, now)` = cœur PUR du moteur tunnel,
 * recompute FROM-SCRATCH (pas d'incrément). Porté à l'identique de
 * `bridge/src/score-tunnel.ts` (`computeTunnelScore`) — c'est l'ANCRE DE PARITÉ :
 * les mêmes signaux produisent le même score des deux côtés.
 *
 * Grille tunnel (ordre strict imposé lead : arrivée < scroll < clic CTA <
 * identify(email) < app_started < RDV) :
 *
 *   Famille Notifuse (100 % des prospects, email-events seuls)
 *     OPEN_FIRST       +5   non cumulable (cap 5) — signal FAIBLE et bruité
 *                            (MPP / proxys préchargent le pixel). Ne fait
 *                            JAMAIS basculer chaud à lui seul (5 < seuil 30).
 *     CLICK_FIRST      +20  1er clic. clics dédupliqués côté store/DB.
 *     CLICK_EXTRA      +10  par clic supplémentaire, cap total +40.
 *     EMAIL_REPLIED    +35  extension HUB (le tunnel bridge ne connaît pas le
 *                            reply) — une réponse directe = intention forte,
 *                            entre identify(35) et RDV(50). Non cumulable.
 *
 *   Famille Analytics (null pour les non-consentants cookies)
 *     AUDIT_VIEW       +10  a ouvert l'audit.
 *     AUDIT_SCROLL_75  +15  a scrollé ≥75 % de l'audit.
 *     HOT_PAGE         +15  par page chaude unique (/tarifs /contact /roi),
 *                            cap +30.
 *     OTHER_PAGE       +5   par autre page unique, cap +15.
 *     CTA_CLICK        +20  a cliqué un CTA (rdv / lead).
 *     IDENTIFY_EMAIL   +35  a saisi son email (slug devenu email).
 *     APP_STARTED      +40  a démarré une app Veridian (notifuse/prospection).
 *                            Non cumulable. +40 seul = chaud d'office.
 *     RDV_BOOKED       +50  a réservé un RDV.
 *     RETURN_VISIT     +15  ≥2 sessions.
 *
 *   consent_granted = 0 point (tracké, ne score JAMAIS — décision lead).
 *   Récence : ×1.5 si dernier signal <48h.
 *   Disqualif : bounce dur OU unsubscribe → score 0 + flag disqualified.
 *   Cap final : 100. Label : froid(0) / tiede(<30) / chaud(≥30).
 *   components{} : détail des points (le score n'est pas une boîte noire,
 *                  poussé tel quel dans le CRM).
 */

/** Agrégat des signaux Analytics web d'un prospect (null = non-consentant). */
export interface AnalyticsAggregate {
  /** slug audit OU email normalisé (clé d'agrégation, union des 2). */
  userId: string;
  auditViews: number;
  auditScrollMax: number; // 0-100
  hotPages: number; // /tarifs, /contact, /roi (uniques)
  otherPages: number; // hors audit + hors chaudes (uniques)
  consented: boolean;
  ctaClicks: number;
  rdvBooked: number;
  /** le prospect a saisi son email (slug devenu un email). */
  identifiedByEmail: boolean;
  /** a démarré une app Veridian (notifuse/prospection), non cumulable. */
  appStarted: boolean;
  sessions: number;
  lastSeen: Date | null;
}

/** Agrégat des signaux Notifuse (email-events) d'un prospect. */
export interface NotifuseSignals {
  /** email normalisé lowercase+trim. */
  email: string;
  /** au moins un email.sent reçu (baseline, ne score pas). */
  sent: boolean;
  /** au moins un email.opened (pixel d'ouverture, signal FAIBLE et bruité). */
  opened: boolean;
  /** clics distincts (dédupliqués par event). */
  clicks: number;
  /**
   * au moins un email.replied — extension HUB (absent du tunnel bridge).
   * Réponse directe = intention forte (+35, cf EMAIL_REPLIED).
   */
  replied: boolean;
  /** hard bounce → disqualified (doNotContact). */
  bounced: boolean;
  /** email.unsubscribed → disqualified (doNotContact). */
  unsubscribed: boolean;
  lastEventAt: Date | null;
}

export type ProspectLabel = 'froid' | 'tiede' | 'chaud';

export interface ProspectScoreResult {
  email: string;
  score: number; // 0-100 entier
  label: ProspectLabel;
  /** bounce dur ou opt-out → disqualifié (doNotContact côté CRM). */
  disqualified: boolean;
  lastSignalAt: Date | null;
  /** détail des points — poussé tel quel dans le CRM (score explicable). */
  components: Record<string, number>;
}

// Grille — ordre strict : AUDIT_VIEW < AUDIT_SCROLL < CTA < IDENTIFY < APP < RDV.
// ⚠️ consent_granted = 0 point (tranché lead 2026-06-10) : accepter les cookies
// n'est pas un signal d'intention d'achat. L'event reste tracké, il ne score
// JAMAIS.
// ⚠️ OPEN_FIRST = 5 NON cumulable (validé lead 2026-06-11) : pixel d'ouverture
// bruité (MPP / proxys préchargent côté serveur). Cap 5 quel que soit le nombre
// d'ouvertures, pour qu'il ne puisse JAMAIS faire passer tiède→chaud seul (seuil
// 30) — invariant "2 clics = 30 = chaud" préservé. Le clic (CLICK_FIRST=20)
// reste 4× plus fort (tracké server-side fiable).
const POINTS = {
  OPEN_FIRST: 5,
  CLICK_FIRST: 20,
  CLICK_EXTRA: 10,
  CLICK_CAP: 40,
  // EMAIL_REPLIED = +35 — extension HUB (le tunnel bridge ne connaît pas le
  // reply). Une réponse directe à un email = intention forte, au même niveau
  // qu'identify (donner son email) et sous le RDV humain (50). Non cumulable
  // (booléen) : répondre 1 ou 5 fois = +35 une fois.
  EMAIL_REPLIED: 35,
  AUDIT_VIEW: 10,
  AUDIT_SCROLL_75: 15,
  HOT_PAGE: 15,
  HOT_PAGE_CAP: 30,
  OTHER_PAGE: 5,
  OTHER_PAGE_CAP: 15,
  CTA_CLICK: 20,
  IDENTIFY_EMAIL: 35,
  // app_started = +40 NON cumulable (validé lead 2026-06-11). Démarrer une app
  // Veridian = signal d'USAGE concret : plus fort que donner son email (35),
  // moins que demander un RDV humain (50). +40 seul = chaud d'office (>30).
  APP_STARTED: 40,
  RDV_BOOKED: 50,
  RETURN_VISIT: 15,
} as const;

const RECENCY_WINDOW_MS = 48 * 60 * 60 * 1000;
const RECENCY_MULTIPLIER = 1.5;
const SCORE_CAP = 100;
const CHAUD_THRESHOLD = 30;

/**
 * Calcule le score d'un prospect FROM-SCRATCH sur l'agrégat de ses signaux.
 * Fonction PURE (zéro I/O) — portée à l'identique du bridge tunnel-de-vente
 * (`computeTunnelScore`), plus l'extension HUB `replied`.
 *
 * @param notifuse  signaux email-events (toujours présents).
 * @param analytics signaux web (null pour les non-consentants cookies).
 * @param now       horloge injectée (récence) — défaut : maintenant.
 */
export function computeProspectScore(
  notifuse: NotifuseSignals,
  analytics: AnalyticsAggregate | null,
  now: Date = new Date(),
): ProspectScoreResult {
  const components: Record<string, number> = {};

  const disqualified = notifuse.bounced || notifuse.unsubscribed;
  if (disqualified) {
    return {
      email: notifuse.email,
      score: 0,
      label: 'froid',
      disqualified: true,
      lastSignalAt: latestDate(notifuse.lastEventAt, analytics?.lastSeen ?? null),
      components: { disqualified: 1 },
    };
  }

  // Famille Notifuse — disponible pour 100 % des prospects.
  // Ouverture : +5 NON cumulable. Le clic implique l'ouverture mais on ne
  // double pas — opened et clicks sont des composants distincts, l'ouverture
  // reste un plancher faible qui ne déclasse jamais.
  if (notifuse.opened) {
    components.email_opened = POINTS.OPEN_FIRST;
  }
  if (notifuse.clicks > 0) {
    components.email_clicks = Math.min(
      POINTS.CLICK_FIRST + (notifuse.clicks - 1) * POINTS.CLICK_EXTRA,
      POINTS.CLICK_CAP,
    );
  }
  // Reply : extension HUB, +35 non cumulable (booléen).
  if (notifuse.replied) {
    components.email_replied = POINTS.EMAIL_REPLIED;
  }

  // Famille Analytics — null pour les non-consentants.
  if (analytics) {
    if (analytics.auditViews > 0) components.audit_view = POINTS.AUDIT_VIEW;
    if (analytics.auditScrollMax >= 75)
      components.audit_scroll = POINTS.AUDIT_SCROLL_75;
    // analytics.consented : tracké mais ne score jamais (décision lead).
    if (analytics.hotPages > 0)
      components.hot_pages = Math.min(
        analytics.hotPages * POINTS.HOT_PAGE,
        POINTS.HOT_PAGE_CAP,
      );
    if (analytics.otherPages > 0)
      components.other_pages = Math.min(
        analytics.otherPages * POINTS.OTHER_PAGE,
        POINTS.OTHER_PAGE_CAP,
      );
    if (analytics.ctaClicks > 0) components.cta_click = POINTS.CTA_CLICK;
    if (analytics.identifiedByEmail)
      components.identify_email = POINTS.IDENTIFY_EMAIL;
    if (analytics.appStarted) components.app_started = POINTS.APP_STARTED;
    if (analytics.rdvBooked > 0) components.rdv_booked = POINTS.RDV_BOOKED;
    if (analytics.sessions >= 2) components.return_visit = POINTS.RETURN_VISIT;
  }

  let score = Object.values(components).reduce((a, b) => a + b, 0);

  const lastSignalAt = latestDate(
    notifuse.lastEventAt,
    analytics?.lastSeen ?? null,
  );
  if (
    score > 0 &&
    lastSignalAt &&
    now.getTime() - lastSignalAt.getTime() < RECENCY_WINDOW_MS
  ) {
    components.recency_multiplier = RECENCY_MULTIPLIER;
    score = score * RECENCY_MULTIPLIER;
  }

  score = Math.min(Math.round(score), SCORE_CAP);

  return {
    email: notifuse.email,
    score,
    label: score === 0 ? 'froid' : score < CHAUD_THRESHOLD ? 'tiede' : 'chaud',
    disqualified: false,
    lastSignalAt,
    components,
  };
}

function latestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

// ============================================================================
// AGRÉGATION events → signaux (l'équivalent Hub de `aggregateEvents` +
// `notifuseSignalsFromStore` du bridge). PURE — relit les `prospect_events`
// d'un prospect et reconstruit (NotifuseSignals, AnalyticsAggregate) que
// `computeProspectScore` consomme. L'ingestion relit les events dans la tx et
// appelle ces deux fonctions for-scratch (recompute).
// ============================================================================

/** Forme minimale d'un `prospect_events` relu pour l'agrégation. */
export interface AggregableEvent {
  eventType: string;
  occurredAt: Date;
  /** payload brut (page_path, link_url, goal_name, properties.app, ...). */
  data?: Record<string, unknown> | null;
}

/** Pages "chaudes" (grille validée lead). */
const HOT_PATHS = new Set(['/tarifs', '/contact', '/roi']);

/**
 * Whitelist des `app` qui valent le +40 APP_STARTED. Seules les vraies apps
 * SaaS Hub comptent (roi-calculator exclu — déjà couvert par HOT_PAGE(/roi) +
 * CTA). Contrat §4a-bis.
 */
const APP_STARTED_SCORED_APPS = new Set(['notifuse', 'prospection']);

/** Lit une chaîne dans le `data` d'un event (sûr vis-à-vis des types). */
function dataString(
  data: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Lit un nombre dans le `data` d'un event. */
function dataNumber(
  data: Record<string, unknown> | null | undefined,
  key: string,
): number {
  const v = data?.[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reconstruit les signaux d'un prospect depuis ses events relus.
 *
 * Mapping eventType → signal :
 *   email.opened   → notifuse.opened = true
 *   email.clicked  → notifuse.clicks++ (1 clic = 1 event après dédup idempotence)
 *   email.replied  → notifuse.replied = true (extension HUB)
 *   email.bounced  → notifuse.bounced = true (disqualif)
 *   email.unsubscribed → notifuse.unsubscribed = true (disqualif)
 *   page.hit       → analytics : audit / hot / other selon data.page_path
 *
 * Sémantiques analytics riches (cta / identify / rdv / app_started / scroll)
 * portées et prêtes : si une app émet un page.hit/goal qui les porte (data
 * .goal_name / .app / .max_scroll), l'agrégateur les reconnaît. Au V1 le Hub
 * ne reçoit que open/click/replied/page.hit basique — les branches riches
 * restent inertes tant qu'aucun émetteur ne les alimente (forward-compat).
 *
 * @param email  email normalisé du prospect (clé d'agrégation).
 * @param events events relus (n'importe quel ordre).
 */
export function aggregateSignals(
  email: string,
  events: readonly AggregableEvent[],
): { notifuse: NotifuseSignals; analytics: AnalyticsAggregate | null } {
  const notifuse: NotifuseSignals = {
    email,
    sent: false,
    opened: false,
    clicks: 0,
    replied: false,
    bounced: false,
    unsubscribed: false,
    lastEventAt: null,
  };

  // Analytics agrégé à la demande (reste null si aucun signal web reçu —
  // équivalent du non-consentant côté bridge).
  let analytics: AnalyticsAggregate | null = null;
  const hotPaths = new Set<string>();
  const otherPaths = new Set<string>();
  const sessions = new Set<string>();

  const ensureAnalytics = (): AnalyticsAggregate => {
    if (!analytics) {
      analytics = {
        userId: email,
        auditViews: 0,
        auditScrollMax: 0,
        hotPages: 0,
        otherPages: 0,
        consented: false,
        ctaClicks: 0,
        rdvBooked: 0,
        identifiedByEmail: false,
        appStarted: false,
        sessions: 0,
        lastSeen: null,
      };
    }
    return analytics;
  };

  for (const ev of events) {
    const at = ev.occurredAt instanceof Date ? ev.occurredAt : new Date(ev.occurredAt);
    const validAt = !Number.isNaN(at.getTime());

    switch (ev.eventType) {
      case 'email.sent':
        notifuse.sent = true;
        break;
      case 'email.opened':
        notifuse.opened = true;
        break;
      case 'email.clicked':
        // 1 event = 1 clic distinct (l'idempotence applicative a déjà dédupliqué
        // les replays au niveau prospect_events.idempotency_key).
        notifuse.clicks += 1;
        break;
      case 'email.replied':
        notifuse.replied = true;
        break;
      case 'email.bounced':
        notifuse.bounced = true;
        break;
      case 'email.unsubscribed':
      case 'email.complained':
        notifuse.unsubscribed = true;
        break;
      case 'page.hit': {
        const a = ensureAnalytics();
        const path = dataString(ev.data, 'page_path') ?? dataString(ev.data, 'path');
        const sid = dataString(ev.data, 'session_id');
        if (sid) {
          sessions.add(sid);
          a.sessions = sessions.size;
        }
        if (a.consented === false && ev.data?.consented === true) {
          a.consented = true;
        }
        if (path) {
          if (path.startsWith('/audit/')) {
            a.auditViews += 1;
            const scroll = dataNumber(ev.data, 'max_scroll');
            if (scroll > a.auditScrollMax) a.auditScrollMax = scroll;
          } else if (HOT_PATHS.has(path)) {
            hotPaths.add(path);
            a.hotPages = hotPaths.size;
          } else {
            otherPaths.add(path);
            a.otherPages = otherPaths.size;
          }
        }
        // Goals web riches portés dans data.goal_name (forward-compat).
        applyGoal(a, ev.data);
        if (validAt && (!a.lastSeen || at > a.lastSeen)) a.lastSeen = at;
        break;
      }
      default:
        // eventType inconnu : ingéré pour forensics, ne déplace aucun signal.
        break;
    }

    if (validAt && (!notifuse.lastEventAt || at > notifuse.lastEventAt)) {
      notifuse.lastEventAt = at;
    }
  }

  return { notifuse, analytics };
}

/**
 * Applique un goal web riche (cta / rdv / consent / signup / app_started /
 * scroll) porté dans `data.goal_name`. Reproduit le mapping bridge
 * (`aggregateEvents`). Inerte si l'event ne porte pas de goal (cas V1).
 */
function applyGoal(
  a: AnalyticsAggregate,
  data: Record<string, unknown> | null | undefined,
): void {
  const goal = dataString(data, 'goal_name');
  if (!goal) return;
  switch (goal) {
    case 'audit_view':
    case 'audit_page_view':
      if (a.auditViews === 0) a.auditViews = 1;
      break;
    case 'audit_scroll':
    case 'scroll_depth': {
      const depth = dataNumber(data, 'depth');
      if (depth > a.auditScrollMax) a.auditScrollMax = depth;
      break;
    }
    case 'audit_cta_rdv':
    case 'appointment_click':
    case 'roi_lead_click':
    case 'cta_click':
      a.ctaClicks += 1;
      break;
    case 'rdv_booked':
      a.rdvBooked += 1;
      break;
    case 'consent_granted':
      a.consented = true; // tracké, ne score JAMAIS.
      break;
    case 'signup':
      a.identifiedByEmail = true;
      break;
    case 'app_started':
      // +40 UNIQUEMENT pour les vraies apps SaaS Hub (whitelist §4a-bis).
      if (APP_STARTED_SCORED_APPS.has(dataString(data, 'app') ?? '')) {
        a.appStarted = true;
      }
      break;
    default:
      break;
  }
}

/** Set des eventTypes qui déplacent un signal (vs ingérés-pour-forensics seuls). */
export const SCORING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'email.sent',
  'email.opened',
  'email.clicked',
  'email.replied',
  'email.bounced',
  'email.unsubscribed',
  'email.complained',
  'page.hit',
]);

/** True si l'eventType influence le score (sinon : ingéré pour forensics seul). */
export function isScoringEventType(eventType: string): boolean {
  return SCORING_EVENT_TYPES.has(eventType);
}

// ============================================================================
// MOTEUR PLUGGABLE — interface ScoringEngine + registre.
//
// "Chacun son scoring engine" (Robert 2026-06-17). Le barème tunnel n'est qu'UN
// moteur ; l'interface abstrait le calcul pour qu'on puisse en brancher d'autres
// (autre grille, autre app, A/B d'un barème) sans rien changer en amont. Le job
// de scoring découplé choisit son moteur par `id` via `getScoringEngine`.
// ============================================================================

/** Signaux agrégés d'un prospect, en entrée d'un moteur de scoring. */
export interface AggregatedSignals {
  notifuse: NotifuseSignals;
  /** null = pas de signal web (non-consentant cookies / aucun page.hit). */
  analytics: AnalyticsAggregate | null;
}

/**
 * Moteur de scoring pluggable. Une implémentation = une grille/un algorithme.
 * `compute` est PURE (zéro I/O) : signaux agrégés → score explicable.
 */
export interface ScoringEngine {
  /** Identifiant stable (persisté avec le score pour tracer quel moteur a noté). */
  readonly id: string;
  /** Libellé humain (dashboards / debug). */
  readonly label: string;
  compute(signals: AggregatedSignals, now?: Date): ProspectScoreResult;
}

/**
 * Moteur tunnel — barème porté du bridge tunnel-de-vente. Premier (et seul au
 * 2026-06-17) moteur du registre. Wrappe `computeProspectScore` (le cœur PUR).
 */
export const tunnelScoringEngine: ScoringEngine = {
  id: 'tunnel-v2',
  label: 'Tunnel de vente (barème bridge V2)',
  compute(signals, now) {
    return computeProspectScore(signals.notifuse, signals.analytics, now);
  },
};

/** Registre des moteurs disponibles, indexés par `id`. */
export const SCORING_ENGINES: ReadonlyMap<string, ScoringEngine> = new Map([
  [tunnelScoringEngine.id, tunnelScoringEngine],
]);

/** Moteur par défaut (le job de scoring l'utilise s'il n'en précise pas un autre). */
export const DEFAULT_SCORING_ENGINE_ID = tunnelScoringEngine.id;

/**
 * Récupère un moteur par `id`. Sans `id`, renvoie le moteur par défaut. Un `id`
 * inconnu lève (configuration erronée = on échoue tôt, pas de score silencieux).
 */
export function getScoringEngine(id: string = DEFAULT_SCORING_ENGINE_ID): ScoringEngine {
  const engine = SCORING_ENGINES.get(id);
  if (!engine) {
    throw new Error(
      `[prospect:scoring] moteur inconnu '${id}'. Disponibles : ${Array.from(SCORING_ENGINES.keys()).join(', ')}`,
    );
  }
  return engine;
}

/**
 * Helper de bout en bout pour la couche scoring découplée : agrège les events
 * d'un prospect puis applique un moteur. Le job/cron de scoring relit les events
 * (DB, son I/O à lui) et appelle ceci — fonction PURE (events en entrée, pas de
 * lecture DB ici).
 *
 * @param email   email normalisé du prospect.
 * @param events  ses events relus (n'importe quel ordre).
 * @param engine  moteur à appliquer (défaut : tunnel).
 * @param now     horloge injectée (récence).
 */
export function scoreProspectFromEvents(
  email: string,
  events: readonly AggregableEvent[],
  engine: ScoringEngine = tunnelScoringEngine,
  now?: Date,
): ProspectScoreResult {
  const signals = aggregateSignals(email, events);
  return engine.compute(signals, now);
}
