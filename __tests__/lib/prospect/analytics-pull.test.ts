/**
 * Tests du pull Analytics → events comportementaux (lib/prospect/analytics-pull).
 *
 * Porté de `veridian-tunnel-de-vente/bridge/tests/analytics-pull.test.ts`,
 * adapté au modèle Hub : au lieu d'un store SQLite, on vérifie les appels
 * `ingestProspectEvent` (eventType, idempotency_key DÉTERMINISTE, jointure
 * email/slug). Invariant central : re-pull d'un état convergé = 0 doublon (les
 * idempotency_key sont stables → la dédup `prospect_events` absorbe le déjà-vu).
 */

import { describe, it, expect, vi } from 'vitest';

import {
  aggregateEvents,
  pullAnalytics,
  PULL_WINDOW_MS,
  type PullDeps
} from '@/lib/prospect/analytics-pull';
import type { ExportedEvent } from '@/lib/prospect/engine-client';
import type { IngestEventInput, IngestResult } from '@/lib/prospect/ingest';

function evt(over: Partial<ExportedEvent>): ExportedEvent {
  return {
    id: Math.random().toString(36).slice(2),
    session_id: 's1',
    user_id: 'tramtech-x7k2q1aa',
    name: 'screen_view',
    path: '/audit/tramtech-x7k2q1aa',
    created_at: '2026-06-10 10:00:00.000',
    updated_at: '2026-06-10 10:00:30.000',
    goal_name: '',
    goal_value: 0,
    goal_timestamp: null,
    max_scroll: 0,
    duration: 1000,
    ...over
  };
}

// ---------------------------------------------------------------------------
// aggregateEvents — jalons audit déterministes (sémantique SCORING-V1 §3).
// ---------------------------------------------------------------------------

describe('aggregateEvents — jalons audit + pages web', () => {
  it('parcours audit complet : page_view + scroll≥75 + cta', () => {
    const aggs = aggregateEvents([
      evt({ max_scroll: 80 }), // audit view + scroll ≥75
      evt({ path: '/tarifs' }), // page web (page.hit)
      evt({ path: '/tarifs', session_id: 's2' }), // même page (dédup interne)
      evt({ path: '/blog', session_id: 's2' }), // autre page web
      evt({
        name: 'goal',
        goal_name: 'audit_cta_rdv', // nom RÉEL site → jalon cta_click
        goal_timestamp: '2026-06-10 10:05:00.000'
      }),
      evt({ name: 'goal', goal_name: 'consent_granted' }) // ne score JAMAIS
    ]);
    const entry = aggs.get('tramtech-x7k2q1aa')!;
    expect(entry.milestones.has('audit.page_view')).toBe(true);
    expect(entry.milestones.has('audit.scroll')).toBe(true); // 80 ≥ 75
    expect(entry.milestones.has('audit.cta_click')).toBe(true);
    expect(entry.isEmail).toBe(false);
    // /tarifs (unique) + /blog = 2 pages web distinctes
    expect([...entry.pageHits.keys()].sort()).toEqual(['/blog', '/tarifs']);
  });

  it('goal audit_scroll depth (property G1) déclenche le jalon scroll', () => {
    const aggs = aggregateEvents([
      evt({
        name: 'goal',
        goal_name: 'audit_scroll',
        properties: { depth: '75', slug: 'tramtech-x7k2q1aa' }
      })
    ]);
    expect(aggs.get('tramtech-x7k2q1aa')!.milestones.has('audit.scroll')).toBe(
      true
    );
  });

  it('scroll < 75 ne déclenche pas le jalon scroll', () => {
    const aggs = aggregateEvents([evt({ max_scroll: 50 })]);
    const entry = aggs.get('tramtech-x7k2q1aa')!;
    expect(entry.milestones.has('audit.page_view')).toBe(true);
    expect(entry.milestones.has('audit.scroll')).toBe(false);
  });

  it('user_id email → isEmail true', () => {
    const aggs = aggregateEvents([evt({ user_id: 'p@x.fr', path: '/compte' })]);
    const entry = aggs.get('p@x.fr')!;
    expect(entry.isEmail).toBe(true);
    expect(entry.pageHits.has('/compte')).toBe(true);
  });

  it('goal Hub signup → jalon signup (contrat Hub 2026-06-11)', () => {
    const aggs = aggregateEvents([
      evt({
        user_id: 'lead@x.fr',
        name: 'goal',
        goal_name: 'signup',
        path: '/',
        goal_timestamp: '2026-06-10 09:00:00.000'
      })
    ]);
    expect(aggs.get('lead@x.fr')!.milestones.has('signup')).toBe(true);
  });

  it('app_started app:notifuse → jalon app.started (whitelist Hub)', () => {
    const aggs = aggregateEvents([
      evt({
        user_id: 'lead@x.fr',
        name: 'goal',
        goal_name: 'app_started',
        properties: { app: 'notifuse' }
      })
    ]);
    expect(aggs.get('lead@x.fr')!.milestones.has('app.started')).toBe(true);
  });

  it('app_started app:roi-calculator → EXCLU (contrat §4a-bis)', () => {
    const aggs = aggregateEvents([
      evt({
        user_id: 'lead@x.fr',
        name: 'goal',
        goal_name: 'app_started',
        properties: { app: 'roi-calculator' }
      })
    ]);
    expect(aggs.get('lead@x.fr')!.milestones.has('app.started')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pullAnalytics — émission idempotente vers ingestProspectEvent.
// ---------------------------------------------------------------------------

/** Engine fake : restitue une seule page d'export figée. */
function fakeEngine(pages: ExportedEvent[][], configured = true) {
  return {
    isConfigured: () => configured,
    async *exportAll() {
      for (const p of pages) yield p;
    }
  };
}

/**
 * Capture les appels d'ingestion ; renvoie ingested:true (1ère fois), false en
 * replay (comme la vraie route via idempotency_key UNIQUE). Le scoring est
 * découplé (archi 2026-06-17) → l'ingestion ne renvoie plus de score ; on
 * neutralise scored/points (le pull n'en dépend pas).
 */
function recordingIngest() {
  const seen = new Set<string>();
  const calls: IngestEventInput[] = [];
  const ingest = vi.fn(
    async (input: IngestEventInput): Promise<IngestResult> => {
      calls.push(input);
      if (seen.has(input.idempotencyKey)) {
        return { ingested: false, scored: false, points: 0 };
      }
      seen.add(input.idempotencyKey);
      return { ingested: true, scored: false, points: 0 };
    }
  );
  return { ingest, calls };
}

describe('pullAnalytics — orchestration idempotente', () => {
  it('skip propre sans credentials engine (skipped:true, 0 émis)', async () => {
    const { ingest, calls } = recordingIngest();
    const deps: PullDeps = {
      engine: fakeEngine([], false),
      ingest,
      workspaceSlug: 'vrd_veridian_site_prod'
    };
    const summary = await pullAnalytics(deps);
    expect(summary.skipped).toBe(true);
    expect(summary.emitted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('identité email → page.hit + jalons audit attribuables, idempotency_key déterministe', async () => {
    const { ingest, calls } = recordingIngest();
    const deps: PullDeps = {
      engine: fakeEngine([
        [
          evt({ user_id: 'lead@x.fr', path: '/tarifs', name: 'screen_view' }),
          evt({
            user_id: 'lead@x.fr',
            name: 'goal',
            goal_name: 'audit_cta_rdv'
          })
        ]
      ]),
      ingest,
      workspaceSlug: 'vrd_veridian_site_prod'
    };
    const summary = await pullAnalytics(deps);

    // 1 page.hit (/tarifs) + 1 jalon cta_click = 2 events, tous attribuables (email).
    expect(summary.emitted).toBe(2);
    expect(summary.ingested).toBe(2);
    expect(summary.attributable).toBe(2); // identité email → events attribuables

    const byKey = new Map(calls.map((c) => [c.idempotencyKey, c]));
    const hit = byKey.get('analytics:lead@x.fr:page.hit:/tarifs')!;
    expect(hit.eventType).toBe('page.hit');
    expect(hit.contactEmail).toBe('lead@x.fr');
    expect(hit.vid).toBeNull();
    expect(hit.app).toBe('analytics');

    const cta = byKey.get('analytics:lead@x.fr:audit.cta_click')!;
    expect(cta.eventType).toBe('audit.cta_click');
    expect(cta.contactEmail).toBe('lead@x.fr');
  });

  it('identité slug anonyme → events ingérés mais NON attribuables, vid = slug', async () => {
    const { ingest, calls } = recordingIngest();
    const deps: PullDeps = {
      engine: fakeEngine([
        [evt({ user_id: 'tramtech-x7k2q1aa', max_scroll: 90 })]
      ]),
      ingest,
      workspaceSlug: 'vrd_veridian_site_prod'
    };
    const summary = await pullAnalytics(deps);
    expect(summary.ingested).toBeGreaterThan(0); // ingéré pour forensics
    expect(summary.attributable).toBe(0); // slug anonyme = pas de prospect joint
    const pv = calls.find(
      (c) => c.idempotencyKey === 'analytics:tramtech-x7k2q1aa:audit.page_view'
    )!;
    expect(pv.contactEmail).toBeNull();
    expect(pv.vid).toBe('tramtech-x7k2q1aa'); // corrélation étage 2 future
  });

  it('re-pull du même état convergé = 0 doublon (invariant DoD §6.4)', async () => {
    const page = [
      evt({ user_id: 'lead@x.fr', path: '/tarifs' }),
      evt({ user_id: 'lead@x.fr', name: 'goal', goal_name: 'rdv_booked' })
    ];
    const { ingest } = recordingIngest();
    const deps: PullDeps = {
      engine: fakeEngine([page]),
      ingest,
      workspaceSlug: 'vrd_veridian_site_prod'
    };
    const first = await pullAnalytics(deps);
    expect(first.ingested).toBeGreaterThan(0);

    // 2e passage : mêmes idempotency_key → tout dédupliqué.
    const second = await pullAnalytics({ ...deps, engine: fakeEngine([page]) });
    expect(second.emitted).toBe(first.emitted); // mêmes appels émis
    expect(second.ingested).toBe(0); // mais 0 nouvel event
  });

  it('borne la fenêtre de pull à 48 h (since = now − 48h)', async () => {
    const { ingest } = recordingIngest();
    const fixedNow = new Date('2026-06-17T12:00:00.000Z');
    const summary = await pullAnalytics({
      engine: fakeEngine([]),
      ingest,
      workspaceSlug: 'vrd_veridian_site_prod',
      now: () => fixedNow
    });
    expect(summary.until).toBe(fixedNow.toISOString());
    expect(
      new Date(summary.until).getTime() - new Date(summary.since).getTime()
    ).toBe(PULL_WINDOW_MS);
  });
});
