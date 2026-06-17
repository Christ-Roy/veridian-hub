/**
 * Tests du barème de scoring (lib/prospect/scoring.ts) — RECOMPUTE PUR.
 *
 * `computeProspectScore` est le portage à l'identique de `computeTunnelScore`
 * du bridge tunnel-de-vente (`bridge/src/score-tunnel.ts`). Les cas ci-dessous
 * RÉPLIQUENT `bridge/tests/score-tunnel.test.ts` (mêmes assertions de score)
 * → ils PROUVENT la parité du barème entre les deux implémentations. Un barème
 * faux ici doit faire échouer un test (sabotage-test : les valeurs sont
 * vérifiées au point exact, pas en > / <).
 *
 * `aggregateSignals` (events → signaux) est l'équivalent Hub de `aggregateEvents`
 * + `notifuseSignalsFromStore` du bridge. Testé séparément (mapping eventType
 * → signal, caps de clics, pages chaudes/autres, disqualif).
 */

import { describe, it, expect } from 'vitest';

import {
  computeProspectScore,
  aggregateSignals,
  isScoringEventType,
  tunnelScoringEngine,
  getScoringEngine,
  scoreProspectFromEvents,
  SCORING_ENGINES,
  DEFAULT_SCORING_ENGINE_ID,
  type NotifuseSignals,
  type AnalyticsAggregate,
  type AggregableEvent,
  type ScoringEngine,
} from '@/lib/prospect/scoring';

const NOW = new Date('2026-06-10T12:00:00Z');
const OLD = new Date('2026-06-01T12:00:00Z'); // > 48h
const RECENT = new Date('2026-06-09T12:00:00Z'); // < 48h

function notifuse(over: Partial<NotifuseSignals> = {}): NotifuseSignals {
  return {
    email: 'prospect@example.com',
    sent: true,
    opened: false,
    clicks: 0,
    replied: false,
    bounced: false,
    unsubscribed: false,
    lastEventAt: OLD,
    ...over,
  };
}

function analytics(over: Partial<AnalyticsAggregate> = {}): AnalyticsAggregate {
  return {
    userId: 'tramtech-depannage-x7k2q1aa',
    auditViews: 0,
    auditScrollMax: 0,
    hotPages: 0,
    otherPages: 0,
    consented: false,
    ctaClicks: 0,
    rdvBooked: 0,
    identifiedByEmail: false,
    appStarted: false,
    sessions: 1,
    lastSeen: OLD,
    ...over,
  };
}

// ============================================================================
// PARITÉ BRIDGE — cas répliqués verbatim de bridge/tests/score-tunnel.test.ts.
// ============================================================================

describe('computeProspectScore — parité barème bridge', () => {
  it('sent seul = froid (0) — baseline', () => {
    const r = computeProspectScore(notifuse(), null, NOW);
    expect(r.score).toBe(0);
    expect(r.label).toBe('froid');
    expect(r.disqualified).toBe(false);
  });

  it('CONTRAINTE §4a : non-consentant 2 clics = 30 = chaud (email-events seuls)', () => {
    const r = computeProspectScore(notifuse({ clicks: 2 }), null, NOW);
    expect(r.score).toBe(30);
    expect(r.label).toBe('chaud');
  });

  it('1 clic = 20 = tiède', () => {
    const r = computeProspectScore(notifuse({ clicks: 1 }), null, NOW);
    expect(r.score).toBe(20);
    expect(r.label).toBe('tiede');
  });

  it('cap clics à +40 (5 clics ≠ 60)', () => {
    const r = computeProspectScore(notifuse({ clicks: 5 }), null, NOW);
    expect(r.components.email_clicks).toBe(40);
  });

  it('ouverture seule = 5 = tiède (signal faible, validé lead 2026-06-11)', () => {
    const r = computeProspectScore(notifuse({ opened: true }), null, NOW);
    expect(r.components.email_opened).toBe(5);
    expect(r.score).toBe(5);
    expect(r.label).toBe('tiede');
  });

  it('ouverture NON cumulable : reste +5 (le booléen ne compte pas les répétitions)', () => {
    const r = computeProspectScore(notifuse({ opened: true }), null, NOW);
    expect(r.components.email_opened).toBe(5);
  });

  it('ouverture NE fait JAMAIS passer chaud seule (cap 5 < seuil 30)', () => {
    // Même avec récence ×1.5 : 5×1.5 = 7.5 → 8 < 30, reste tiède.
    const r = computeProspectScore(
      notifuse({ opened: true, lastEventAt: RECENT }),
      null,
      NOW,
    );
    expect(r.score).toBeLessThan(30);
    expect(r.label).toBe('tiede');
  });

  it('ouverture + clic : composants distincts, invariant 2 clics = chaud préservé', () => {
    const withOpen = computeProspectScore(
      notifuse({ opened: true, clicks: 2 }),
      null,
      NOW,
    );
    expect(withOpen.components.email_opened).toBe(5);
    expect(withOpen.components.email_clicks).toBe(30);
    expect(withOpen.score).toBe(35);
    expect(withOpen.label).toBe('chaud');
    const noOpen = computeProspectScore(notifuse({ clicks: 2 }), null, NOW);
    expect(noOpen.score).toBe(30);
    expect(noOpen.label).toBe('chaud');
  });

  it('ouverture absente = pas de composant email_opened', () => {
    const r = computeProspectScore(notifuse({ clicks: 1 }), null, NOW);
    expect(r.components.email_opened).toBeUndefined();
  });

  it('hard bounce (DSN) = disqualified, score 0', () => {
    const r = computeProspectScore(notifuse({ bounced: true, clicks: 3 }), null, NOW);
    expect(r.disqualified).toBe(true);
    expect(r.score).toBe(0);
  });

  it('unsubscribe = disqualified (§4c.5)', () => {
    const r = computeProspectScore(notifuse({ unsubscribed: true }), null, NOW);
    expect(r.disqualified).toBe(true);
  });

  it('ORDRE STRICT lead : arrivée(10) < scroll(15) < CTA(20) < identify(35) < RDV(50)', () => {
    const view = computeProspectScore(notifuse(), analytics({ auditViews: 1 }), NOW)
      .components;
    const scroll = computeProspectScore(
      notifuse(),
      analytics({ auditScrollMax: 80 }),
      NOW,
    ).components;
    const cta = computeProspectScore(notifuse(), analytics({ ctaClicks: 1 }), NOW)
      .components;
    const idf = computeProspectScore(
      notifuse(),
      analytics({ identifiedByEmail: true }),
      NOW,
    ).components;
    const rdv = computeProspectScore(notifuse(), analytics({ rdvBooked: 1 }), NOW)
      .components;
    expect(view.audit_view).toBeLessThan(scroll.audit_scroll!);
    expect(scroll.audit_scroll).toBeLessThan(cta.cta_click!);
    expect(cta.cta_click).toBeLessThan(idf.identify_email!);
    expect(idf.identify_email).toBeLessThan(rdv.rdv_booked!);
  });

  it('lecture audit complète = 25 = tiède (10+15, consent NE score PAS)', () => {
    const r = computeProspectScore(
      notifuse(),
      analytics({ auditViews: 1, auditScrollMax: 75, consented: true }),
      NOW,
    );
    expect(r.score).toBe(25);
    expect(r.label).toBe('tiede');
  });

  it('DÉCISION LEAD : consent_granted = 0 point, jamais dans components', () => {
    const withConsent = computeProspectScore(
      notifuse({ clicks: 1 }),
      analytics({ consented: true }),
      NOW,
    );
    const withoutConsent = computeProspectScore(
      notifuse({ clicks: 1 }),
      analytics({ consented: false }),
      NOW,
    );
    expect(withConsent.score).toBe(withoutConsent.score);
    expect(withConsent.components.consent).toBeUndefined();
  });

  it('identify(email) = 35 = chaud direct', () => {
    const r = computeProspectScore(
      notifuse(),
      analytics({ identifiedByEmail: true }),
      NOW,
    );
    expect(r.score).toBe(35);
    expect(r.label).toBe('chaud');
  });

  it('app_started = 40 = chaud d office (validé lead 2026-06-11)', () => {
    const r = computeProspectScore(notifuse(), analytics({ appStarted: true }), NOW);
    expect(r.components.app_started).toBe(40);
    expect(r.score).toBe(40);
    expect(r.label).toBe('chaud');
  });

  it('app_started NON cumulable : reste +40 (booléen, multi-app ne double pas)', () => {
    const r = computeProspectScore(notifuse(), analytics({ appStarted: true }), NOW);
    expect(r.components.app_started).toBe(40);
  });

  it('ORDRE STRICT étendu : identify(35) < app_started(40) < RDV(50)', () => {
    const idf = computeProspectScore(
      notifuse(),
      analytics({ identifiedByEmail: true }),
      NOW,
    ).components;
    const app = computeProspectScore(
      notifuse(),
      analytics({ appStarted: true }),
      NOW,
    ).components;
    const rdv = computeProspectScore(notifuse(), analytics({ rdvBooked: 1 }), NOW)
      .components;
    expect(idf.identify_email).toBeLessThan(app.app_started!);
    expect(app.app_started).toBeLessThan(rdv.rdv_booked!);
  });

  it('RDV = 50 = chaud d office', () => {
    const r = computeProspectScore(notifuse(), analytics({ rdvBooked: 1 }), NOW);
    expect(r.score).toBe(50);
    expect(r.label).toBe('chaud');
  });

  it('caps pages : 5 chaudes → +30, 10 autres → +15', () => {
    const r = computeProspectScore(
      notifuse(),
      analytics({ hotPages: 5, otherPages: 10 }),
      NOW,
    );
    expect(r.components.hot_pages).toBe(30);
    expect(r.components.other_pages).toBe(15);
  });

  it('récence < 48h : ×1.5 (1 clic récent = 30 chaud)', () => {
    const r = computeProspectScore(
      notifuse({ clicks: 1, lastEventAt: RECENT }),
      null,
      NOW,
    );
    expect(r.score).toBe(30);
    expect(r.label).toBe('chaud');
    expect(r.components.recency_multiplier).toBe(1.5);
  });

  it('récence sans signal (score 0) : pas de multiplicateur', () => {
    const r = computeProspectScore(notifuse({ lastEventAt: RECENT }), null, NOW);
    expect(r.score).toBe(0);
    expect(r.components.recency_multiplier).toBeUndefined();
  });

  it('cap final 100', () => {
    const r = computeProspectScore(
      notifuse({ clicks: 5, lastEventAt: RECENT }),
      analytics({
        auditViews: 3,
        auditScrollMax: 100,
        consented: true,
        hotPages: 3,
        otherPages: 8,
        ctaClicks: 2,
        rdvBooked: 1,
        identifiedByEmail: true,
        sessions: 4,
        lastSeen: RECENT,
      }),
      NOW,
    );
    expect(r.score).toBe(100);
    expect(r.label).toBe('chaud');
  });

  it('lastSignalAt = max(Notifuse, Analytics)', () => {
    const r = computeProspectScore(
      notifuse({ clicks: 1, lastEventAt: OLD }),
      analytics({ auditViews: 1, lastSeen: RECENT }),
      NOW,
    );
    expect(r.lastSignalAt?.toISOString()).toBe(RECENT.toISOString());
  });

  it('retour (2 sessions) = +15', () => {
    const r = computeProspectScore(notifuse(), analytics({ sessions: 2 }), NOW);
    expect(r.components.return_visit).toBe(15);
  });
});

// ============================================================================
// EXTENSION HUB — email.replied (absent du tunnel bridge).
// ============================================================================

describe('computeProspectScore — extension HUB email.replied', () => {
  it('reply = +35 = chaud direct (intention forte)', () => {
    const r = computeProspectScore(notifuse({ replied: true }), null, NOW);
    expect(r.components.email_replied).toBe(35);
    expect(r.score).toBe(35);
    expect(r.label).toBe('chaud');
  });

  it('reply non cumulable : booléen, reste +35', () => {
    const r = computeProspectScore(notifuse({ replied: true }), null, NOW);
    expect(r.components.email_replied).toBe(35);
  });

  it('reply absent = pas de composant email_replied', () => {
    const r = computeProspectScore(notifuse({ clicks: 1 }), null, NOW);
    expect(r.components.email_replied).toBeUndefined();
  });

  it('reply disqualifié par un bounce → score 0 (disqualif prime)', () => {
    const r = computeProspectScore(
      notifuse({ replied: true, bounced: true }),
      null,
      NOW,
    );
    expect(r.disqualified).toBe(true);
    expect(r.score).toBe(0);
  });
});

// ============================================================================
// AGRÉGATION events → signaux.
// ============================================================================

function ev(over: Partial<AggregableEvent> & { eventType: string }): AggregableEvent {
  return { occurredAt: OLD, data: null, ...over };
}

describe('aggregateSignals — mapping eventType → signal', () => {
  it('email events → NotifuseSignals (opened/clicks/replied/bounced/unsub)', () => {
    const { notifuse: n } = aggregateSignals('a@b.com', [
      ev({ eventType: 'email.sent' }),
      ev({ eventType: 'email.opened' }),
      ev({ eventType: 'email.clicked' }),
      ev({ eventType: 'email.clicked' }),
      ev({ eventType: 'email.replied' }),
    ]);
    expect(n.sent).toBe(true);
    expect(n.opened).toBe(true);
    expect(n.clicks).toBe(2);
    expect(n.replied).toBe(true);
    expect(n.bounced).toBe(false);
    expect(n.unsubscribed).toBe(false);
  });

  it('1 event email.clicked = 1 clic distinct (dédup en amont via idempotency_key)', () => {
    const { notifuse: n } = aggregateSignals('a@b.com', [
      ev({ eventType: 'email.clicked' }),
      ev({ eventType: 'email.clicked' }),
      ev({ eventType: 'email.clicked' }),
    ]);
    expect(n.clicks).toBe(3);
  });

  it('email.bounced → bounced=true (disqualif via computeProspectScore)', () => {
    const { notifuse: n } = aggregateSignals('a@b.com', [
      ev({ eventType: 'email.bounced' }),
    ]);
    expect(n.bounced).toBe(true);
    const r = computeProspectScore(n, null, NOW);
    expect(r.disqualified).toBe(true);
  });

  it('email.unsubscribed et email.complained → unsubscribed=true', () => {
    expect(
      aggregateSignals('a@b.com', [ev({ eventType: 'email.unsubscribed' })]).notifuse
        .unsubscribed,
    ).toBe(true);
    expect(
      aggregateSignals('a@b.com', [ev({ eventType: 'email.complained' })]).notifuse
        .unsubscribed,
    ).toBe(true);
  });

  it('aucun event web → analytics null (équivalent non-consentant)', () => {
    const { analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'email.opened' }),
    ]);
    expect(a).toBeNull();
  });

  it('page.hit /audit/ → auditViews + auditScrollMax depuis data.max_scroll', () => {
    const { analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { page_path: '/audit/tramtech', max_scroll: 80 } }),
    ]);
    expect(a?.auditViews).toBe(1);
    expect(a?.auditScrollMax).toBe(80);
  });

  it('page.hit pages chaudes uniques → hotPages (dédup par path)', () => {
    const { analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { page_path: '/tarifs' } }),
      ev({ eventType: 'page.hit', data: { page_path: '/tarifs' } }),
      ev({ eventType: 'page.hit', data: { page_path: '/contact' } }),
    ]);
    expect(a?.hotPages).toBe(2); // /tarifs dédupliqué
  });

  it('page.hit autres pages uniques → otherPages', () => {
    const { analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { page_path: '/blog/x' } }),
      ev({ eventType: 'page.hit', data: { page_path: '/blog/y' } }),
    ]);
    expect(a?.otherPages).toBe(2);
  });

  it('page.hit avec session_id distincts → sessions', () => {
    const { analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { page_path: '/x', session_id: 's1' } }),
      ev({ eventType: 'page.hit', data: { page_path: '/y', session_id: 's2' } }),
    ]);
    expect(a?.sessions).toBe(2);
  });

  it('goal app_started (whitelist notifuse/prospection) → appStarted', () => {
    const yes = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { goal_name: 'app_started', app: 'notifuse' } }),
    ]).analytics;
    expect(yes?.appStarted).toBe(true);
    // roi-calculator EXCLU de la whitelist.
    const no = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { goal_name: 'app_started', app: 'roi-calculator' } }),
    ]).analytics;
    expect(no?.appStarted).toBe(false);
  });

  it('goal cta/rdv/signup mappés sur les bons signaux', () => {
    const cta = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { goal_name: 'cta_click' } }),
    ]).analytics;
    expect(cta?.ctaClicks).toBe(1);
    const rdv = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { goal_name: 'rdv_booked' } }),
    ]).analytics;
    expect(rdv?.rdvBooked).toBe(1);
    const signup = aggregateSignals('a@b.com', [
      ev({ eventType: 'page.hit', data: { goal_name: 'signup' } }),
    ]).analytics;
    expect(signup?.identifiedByEmail).toBe(true);
  });

  it('eventType inconnu → aucun signal déplacé', () => {
    const { notifuse: n, analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'tenant.suspended' }),
    ]);
    expect(n.opened).toBe(false);
    expect(n.clicks).toBe(0);
    expect(a).toBeNull();
  });

  it('lastEventAt = max des occurred_at', () => {
    const { notifuse: n } = aggregateSignals('a@b.com', [
      ev({ eventType: 'email.opened', occurredAt: OLD }),
      ev({ eventType: 'email.clicked', occurredAt: RECENT }),
    ]);
    expect(n.lastEventAt?.toISOString()).toBe(RECENT.toISOString());
  });

  it('chaîne complète events → signaux → score (2 clics = 30 chaud)', () => {
    const { notifuse: n, analytics: a } = aggregateSignals('a@b.com', [
      ev({ eventType: 'email.clicked', occurredAt: OLD }),
      ev({ eventType: 'email.clicked', occurredAt: OLD }),
    ]);
    const r = computeProspectScore(n, a, NOW);
    expect(r.score).toBe(30);
    expect(r.label).toBe('chaud');
  });
});

describe('isScoringEventType', () => {
  it('reconnaît les events qui déplacent un signal', () => {
    for (const t of [
      'email.sent',
      'email.opened',
      'email.clicked',
      'email.replied',
      'email.bounced',
      'email.unsubscribed',
      'email.complained',
      'page.hit',
    ]) {
      expect(isScoringEventType(t)).toBe(true);
    }
  });

  it('rejette les events hors barème (ingérés pour forensics)', () => {
    expect(isScoringEventType('tenant.suspended')).toBe(false);
    expect(isScoringEventType('')).toBe(false);
    expect(isScoringEventType('garbage')).toBe(false);
  });
});

// ============================================================================
// MOTEUR PLUGGABLE — ScoringEngine + registre + helper de bout en bout.
// ============================================================================

describe('ScoringEngine — moteur tunnel + registre', () => {
  it('tunnelScoringEngine.compute = computeProspectScore (mêmes signaux, même score)', () => {
    const signals = { notifuse: notifuse({ clicks: 2 }), analytics: null };
    const viaEngine = tunnelScoringEngine.compute(signals, NOW);
    const viaPure = computeProspectScore(signals.notifuse, signals.analytics, NOW);
    expect(viaEngine).toEqual(viaPure);
    expect(viaEngine.score).toBe(30);
    expect(viaEngine.label).toBe('chaud');
  });

  it('le moteur tunnel a un id stable et est le défaut', () => {
    expect(tunnelScoringEngine.id).toBe('tunnel-v2');
    expect(DEFAULT_SCORING_ENGINE_ID).toBe('tunnel-v2');
    expect(SCORING_ENGINES.get('tunnel-v2')).toBe(tunnelScoringEngine);
  });

  it('getScoringEngine() sans id renvoie le moteur par défaut', () => {
    expect(getScoringEngine()).toBe(tunnelScoringEngine);
    expect(getScoringEngine('tunnel-v2')).toBe(tunnelScoringEngine);
  });

  it('getScoringEngine(id inconnu) lève (échoue tôt, pas de score silencieux)', () => {
    expect(() => getScoringEngine('does-not-exist')).toThrow(/moteur inconnu/);
  });

  it('un moteur custom respecte l\'interface et est interchangeable', () => {
    // Prouve le pluggable : un autre barème branché sans toucher au reste.
    const flatEngine: ScoringEngine = {
      id: 'flat-test',
      label: 'Test plat',
      compute: (s) => ({
        email: s.notifuse.email,
        score: 42,
        label: 'chaud',
        disqualified: false,
        lastSignalAt: null,
        components: { flat: 42 },
      }),
    };
    const r = flatEngine.compute({ notifuse: notifuse(), analytics: null });
    expect(r.score).toBe(42);
    expect(r.components.flat).toBe(42);
  });
});

describe('scoreProspectFromEvents — agrège puis applique un moteur (PUR)', () => {
  function ev2(over: Partial<AggregableEvent> & { eventType: string }): AggregableEvent {
    return { occurredAt: OLD, data: null, ...over };
  }

  it('2 clics (events) → tunnel → 30 chaud (chaîne complète events→score)', () => {
    const r = scoreProspectFromEvents(
      'a@b.com',
      [ev2({ eventType: 'email.clicked' }), ev2({ eventType: 'email.clicked' })],
      tunnelScoringEngine,
      NOW,
    );
    expect(r.score).toBe(30);
    expect(r.label).toBe('chaud');
  });

  it('moteur par défaut si non précisé', () => {
    const r = scoreProspectFromEvents(
      'a@b.com',
      [ev2({ eventType: 'email.replied' })],
      undefined,
      NOW,
    );
    expect(r.components.email_replied).toBe(35);
    expect(r.label).toBe('chaud');
  });

  it('bounce dans les events → disqualified, score 0', () => {
    const r = scoreProspectFromEvents(
      'a@b.com',
      [ev2({ eventType: 'email.clicked' }), ev2({ eventType: 'email.bounced' })],
      tunnelScoringEngine,
      NOW,
    );
    expect(r.disqualified).toBe(true);
    expect(r.score).toBe(0);
  });
});
