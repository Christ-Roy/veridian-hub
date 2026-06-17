/**
 * Tests de la couche PUSH CRM (lib/prospect/push-to-crm.ts) — le maillon central
 * de la chaîne découplée `events → scoring → écriture → CRM`.
 *
 * EVENTS ⟂ SCORING — DÉCOUPLÉS (archi Robert 2026-06-17). Ce module RELIT les
 * events agrégés d'un prospect, RECALCULE le score FROM-SCRATCH via un moteur
 * pluggable, l'ÉCRIT en DB, puis le POUSSE au CRM si (et seulement si) il a
 * changé depuis le dernier push (idempotence SORTANTE).
 *
 * Approche : injection de dépendances (PushDeps) plutôt que mock de module — on
 * exerce le VRAI code de routing/idempotence avec un faux Prisma (en mémoire) et
 * un faux CrmClient (qui enregistre les appels). `decryptSecret` est mocké (il
 * lit CRM_VAULT_KEY, hors scope de ces tests). Le moteur de scoring réel
 * (tunnel-v2) est utilisé — on vérifie la séquence, pas le barème (déjà couvert
 * par scoring.test.ts).
 *
 * Ce qu'on verrouille :
 *   - le score est TOUJOURS recalculé + écrit en DB (découplé du push)
 *   - idempotence SORTANTE : pas de re-push si score inchangé
 *   - routing multitenant : tenant_uuid → Tenant → User → CrmTenant → ctx
 *   - skip gracieux si 0 CrmTenant (score écrit, push sauté)
 *   - DRY_RUN : mutations passées en dryRun, crm_pushed_* NON mis à jour
 *   - séquence parité bridge : resolve → timeline → score → doNotContact →
 *     opportunity NEW→SCREENING
 *   - Person introuvable → orphan (person_not_found)
 *   - pushDepsFromEnv : DRY_RUN par défaut true, engineId depuis l'ENV
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const decryptSecretMock = vi.fn();
vi.mock('@/lib/crm/vault', () => ({
  decryptSecret: (...a: unknown[]) => decryptSecretMock(...a),
}));

import { pushDepsFromEnv, pushProspectScores } from '@/lib/prospect/push-to-crm';
import type { AggregableEvent } from '@/lib/prospect/scoring';

// ─── Faux CrmClient : enregistre les appels, simule resolve/opportunity ───────
interface FakeCrmCall {
  method: string;
  args: unknown[];
}

function makeFakeCrmClient(
  opts: {
    person?: { id: string; doNotContact: boolean } | null;
    opportunity?: { id: string; stage: string } | null;
  } = {},
) {
  const calls: FakeCrmCall[] = [];
  const person = opts.person === undefined ? { id: 'person-1', doNotContact: false } : opts.person;
  const opportunity =
    opts.opportunity === undefined ? { id: 'opp-1', stage: 'NEW' } : opts.opportunity;
  return {
    calls,
    resetWriteBudget: vi.fn(() => calls.push({ method: 'resetWriteBudget', args: [] })),
    resolvePersonCached: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'resolvePersonCached', args });
      return person ? { id: person.id, stage: null, doNotContact: person.doNotContact } : null;
    }),
    batchTimeline: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'batchTimeline', args });
    }),
    patchPerson: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'patchPerson', args });
    }),
    opportunityForPerson: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'opportunityForPerson', args });
      return opportunity;
    }),
    patchOpportunityStage: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'patchOpportunityStage', args });
    }),
  };
}

// ─── Faux Prisma : tables en mémoire (prospectEvent, prospectScore, tenant,
// user, crmTenant). Implémente uniquement les méthodes consommées. ────────────
interface FakeProspectEvent {
  workspaceSlug: string;
  contactEmail: string | null;
  tenantUuid: string | null;
  vid: string | null;
  eventType: string;
  occurredAt: Date;
  data: Record<string, unknown> | null;
}

function makeFakePrisma(seed: {
  events: FakeProspectEvent[];
  tenants?: Array<{ id: string; userId: string }>;
  users?: Array<{ id: string; supabaseUserId: string }>;
  crmTenants?: Array<{
    id: string;
    userId: string;
    status: string;
    twentyApiKeyEncrypted: string;
    twentyWorkspaceUrl: string;
  }>;
  scores?: Record<string, { crmPushedScore: number | null }>;
}) {
  // store des scores keyé par `${ws}|${email}`.
  const scoreStore = new Map<
    string,
    {
      workspaceSlug: string;
      contactEmail: string;
      engagementScore: number;
      crmPushedScore: number | null;
      crmPushedAt: Date | null;
      [k: string]: unknown;
    }
  >();
  for (const [k, v] of Object.entries(seed.scores ?? {})) {
    const [workspaceSlug, contactEmail] = k.split('|');
    scoreStore.set(k, {
      workspaceSlug,
      contactEmail,
      engagementScore: 0,
      crmPushedScore: v.crmPushedScore,
      crmPushedAt: null,
    });
  }
  const key = (w: { workspaceSlug: string; contactEmail: string }) =>
    `${w.workspaceSlug}|${w.contactEmail}`;

  return {
    scoreStore,
    prospectEvent: {
      groupBy: vi.fn(async () => {
        const seen = new Set<string>();
        const out: Array<{ workspaceSlug: string; contactEmail: string }> = [];
        for (const e of seed.events) {
          if (e.contactEmail === null) continue;
          const k = `${e.workspaceSlug}|${e.contactEmail}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ workspaceSlug: e.workspaceSlug, contactEmail: e.contactEmail });
        }
        return out;
      }),
      findMany: vi.fn(async (args: { where: { workspaceSlug: string; contactEmail: string } }) =>
        seed.events.filter(
          (e) =>
            e.workspaceSlug === args.where.workspaceSlug &&
            e.contactEmail === args.where.contactEmail,
        ),
      ),
    },
    prospectScore: {
      upsert: vi.fn(
        async (args: {
          where: { workspaceSlug_contactEmail: { workspaceSlug: string; contactEmail: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const w = args.where.workspaceSlug_contactEmail;
          const k = key(w);
          const existing = scoreStore.get(k);
          if (existing) {
            Object.assign(existing, args.update);
          } else {
            scoreStore.set(k, {
              workspaceSlug: w.workspaceSlug,
              contactEmail: w.contactEmail,
              crmPushedScore: null,
              crmPushedAt: null,
              ...(args.create as Record<string, unknown>),
            } as never);
          }
        },
      ),
      findUnique: vi.fn(
        async (args: {
          where: { workspaceSlug_contactEmail: { workspaceSlug: string; contactEmail: string } };
        }) => {
          const k = key(args.where.workspaceSlug_contactEmail);
          const row = scoreStore.get(k);
          return row ? { crmPushedScore: row.crmPushedScore } : null;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { workspaceSlug_contactEmail: { workspaceSlug: string; contactEmail: string } };
          data: Record<string, unknown>;
        }) => {
          const k = key(args.where.workspaceSlug_contactEmail);
          const row = scoreStore.get(k);
          if (row) Object.assign(row, args.data);
        },
      ),
    },
    tenant: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const t = (seed.tenants ?? []).find((x) => x.id === args.where.id);
        return t ? { userId: t.userId } : null;
      }),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { supabaseUserId: string } }) => {
        const u = (seed.users ?? []).find((x) => x.supabaseUserId === args.where.supabaseUserId);
        return u ? { id: u.id } : null;
      }),
    },
    crmTenant: {
      findFirst: vi.fn(async (args: { where: { userId: string } }) => {
        const c = (seed.crmTenants ?? []).find(
          (x) => x.userId === args.where.userId && x.status !== 'deleted',
        );
        return c ?? null;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const c = (seed.crmTenants ?? []).find((x) => x.id === args.where.id);
        return c ?? null;
      }),
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────
const NOW = new Date('2026-06-17T12:00:00.000Z');
const recent = (offsetMs: number) => new Date(NOW.getTime() - offsetMs);

/** Un prospect "chaud" : 2 clics email = score 30+ (chaud), avec email.sent. */
function hotProspectEvents(): FakeProspectEvent[] {
  return [
    {
      workspaceSlug: 'ws_acme',
      contactEmail: 'lead@acme.com',
      tenantUuid: 'tenant-uuid-1',
      vid: null,
      eventType: 'email.sent',
      occurredAt: recent(60 * 60 * 1000),
      data: {},
    },
    {
      workspaceSlug: 'ws_acme',
      contactEmail: 'lead@acme.com',
      tenantUuid: 'tenant-uuid-1',
      vid: null,
      eventType: 'email.clicked',
      occurredAt: recent(30 * 60 * 1000),
      data: {},
    },
    {
      workspaceSlug: 'ws_acme',
      contactEmail: 'lead@acme.com',
      tenantUuid: 'tenant-uuid-1',
      vid: null,
      eventType: 'email.clicked',
      occurredAt: recent(20 * 60 * 1000),
      data: {},
    },
  ];
}

/** Tenant pleinement résolvable → CrmTenant actif (le push réussira). */
function fullTenantChain() {
  return {
    tenants: [{ id: 'tenant-uuid-1', userId: 'uuid-bridge-1' }],
    users: [{ id: 'cuid-user-1', supabaseUserId: 'uuid-bridge-1' }],
    crmTenants: [
      {
        id: 'crm-1',
        userId: 'cuid-user-1',
        status: 'active',
        twentyApiKeyEncrypted: 'enc-key',
        twentyWorkspaceUrl: 'https://acme.crm.veridian.site',
      },
    ],
  };
}

beforeEach(() => {
  decryptSecretMock.mockReset();
  decryptSecretMock.mockReturnValue('decrypted-bearer');
});

describe('pushProspectScores — orchestration découplée events→score→CRM', () => {
  it('recalcule + écrit le score en DB pour chaque prospect (toujours, découplé du push)', async () => {
    const prisma = makeFakePrisma({ events: hotProspectEvents(), ...fullTenantChain() });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });

    expect(summary.candidates).toBe(1);
    expect(summary.scored).toBe(1);
    // Le score a bien été écrit en DB.
    const row = prisma.scoreStore.get('ws_acme|lead@acme.com');
    expect(row).toBeTruthy();
    expect(row?.engagementScore).toBeGreaterThanOrEqual(30); // 2 clics récents = chaud
    expect(row?.label).toBe('chaud');
  });

  it('pousse au CRM la séquence parité bridge : resolve → timeline → score → opportunity NEW→SCREENING', async () => {
    const prisma = makeFakePrisma({ events: hotProspectEvents(), ...fullTenantChain() });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });

    expect(summary.pushed).toBe(1);
    const methods = crm.calls.map((c) => c.method);
    expect(methods).toContain('resolvePersonCached');
    expect(methods).toContain('batchTimeline');
    expect(methods).toContain('patchPerson'); // score
    // email.sent présent → transition opportunity NEW→SCREENING.
    expect(methods).toContain('opportunityForPerson');
    expect(methods).toContain('patchOpportunityStage');
    const stageCall = crm.calls.find((c) => c.method === 'patchOpportunityStage');
    expect(stageCall?.args[2]).toBe('SCREENING');
    // Le score poussé = le score recalculé.
    const scorePatch = crm.calls.find(
      (c) => c.method === 'patchPerson' && (c.args[2] as { score?: number })?.score !== undefined,
    );
    expect((scorePatch?.args[2] as { score: number }).score).toBeGreaterThanOrEqual(30);
  });

  it('idempotence SORTANTE : ne re-pousse PAS si le score est inchangé depuis le dernier push', async () => {
    // Pré-seed : ce prospect a déjà été poussé avec le score qu'il va recalculer.
    const prisma = makeFakePrisma({
      events: hotProspectEvents(),
      ...fullTenantChain(),
      scores: { 'ws_acme|lead@acme.com': { crmPushedScore: 45 } },
    });
    const crm = makeFakeCrmClient();
    // Force le score recalculé à 45 pour matcher crmPushedScore.
    const engine = {
      id: 'fixed-45',
      label: 'fixed',
      compute: () => ({
        email: 'lead@acme.com',
        score: 45,
        label: 'chaud' as const,
        disqualified: false,
        lastSignalAt: NOW,
        components: { email_clicks: 30 },
      }),
    };
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      engine,
      now: () => NOW,
      dryRun: false,
    });

    expect(summary.scored).toBe(1); // score réécrit quand même
    expect(summary.unchanged).toBe(1);
    expect(summary.pushed).toBe(0);
    // Aucune mutation CRM (hors reset budget).
    expect(crm.resolvePersonCached).not.toHaveBeenCalled();
    expect(crm.patchPerson).not.toHaveBeenCalled();
  });

  it('re-pousse si le score a CHANGÉ depuis le dernier push', async () => {
    const prisma = makeFakePrisma({
      events: hotProspectEvents(),
      ...fullTenantChain(),
      scores: { 'ws_acme|lead@acme.com': { crmPushedScore: 10 } }, // ancien score différent
    });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });
    expect(summary.pushed).toBe(1);
    expect(summary.unchanged).toBe(0);
    // crm_pushed_score mis à jour à la nouvelle valeur.
    const row = prisma.scoreStore.get('ws_acme|lead@acme.com');
    expect(row?.crmPushedScore).toBe(row?.engagementScore);
  });

  it('skip gracieux si 0 CrmTenant : score écrit en DB, push sauté (no_crm_tenant)', async () => {
    // Chaîne tenant incomplète : pas de CrmTenant.
    const prisma = makeFakePrisma({
      events: hotProspectEvents(),
      tenants: [{ id: 'tenant-uuid-1', userId: 'uuid-bridge-1' }],
      users: [{ id: 'cuid-user-1', supabaseUserId: 'uuid-bridge-1' }],
      crmTenants: [], // AUCUN CrmTenant
    });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });

    expect(summary.scored).toBe(1); // score quand même écrit
    expect(summary.noCrmTenant).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(crm.resolvePersonCached).not.toHaveBeenCalled();
    // Le score est bien persisté malgré l'absence de CRM.
    expect(prisma.scoreStore.get('ws_acme|lead@acme.com')).toBeTruthy();
  });

  it('skip gracieux si tenant_uuid NULL (event orphelin) : pas de routing CRM', async () => {
    const events = hotProspectEvents().map((e) => ({ ...e, tenantUuid: null }));
    const prisma = makeFakePrisma({ events });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });
    expect(summary.scored).toBe(1);
    expect(summary.noCrmTenant).toBe(1);
    expect(summary.pushed).toBe(0);
  });

  it('DRY_RUN : mutations passées en dryRun et crm_pushed_* NON mis à jour', async () => {
    const prisma = makeFakePrisma({ events: hotProspectEvents(), ...fullTenantChain() });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: true,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.pushed).toBe(1); // séquence exécutée (mutations loguées par le client)
    // Le flag dryRun est propagé aux mutations.
    const patch = crm.calls.find(
      (c) => c.method === 'patchPerson' && (c.args[2] as { score?: number })?.score !== undefined,
    );
    expect((patch?.args[3] as { dryRun?: boolean })?.dryRun).toBe(true);
    // crm_pushed_* NON mis à jour en DRY_RUN (rien réellement poussé).
    const row = prisma.scoreStore.get('ws_acme|lead@acme.com');
    expect(row?.crmPushedScore).toBeNull();
    expect(row?.crmPushedAt).toBeNull();
  });

  it('Person introuvable côté CRM → orphan (person_not_found), pas de patch', async () => {
    const prisma = makeFakePrisma({ events: hotProspectEvents(), ...fullTenantChain() });
    const crm = makeFakeCrmClient({ person: null });
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });
    expect(summary.personNotFound).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(crm.patchPerson).not.toHaveBeenCalled();
  });

  it('disqualif (unsubscribe) → patchPerson doNotContact + score 0', async () => {
    const events: FakeProspectEvent[] = [
      {
        workspaceSlug: 'ws_acme',
        contactEmail: 'lead@acme.com',
        tenantUuid: 'tenant-uuid-1',
        vid: null,
        eventType: 'email.unsubscribed',
        occurredAt: recent(1000),
        data: {},
      },
    ];
    const prisma = makeFakePrisma({ events, ...fullTenantChain() });
    const crm = makeFakeCrmClient();
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });
    expect(summary.pushed).toBe(1);
    const dncCall = crm.calls.find(
      (c) =>
        c.method === 'patchPerson' &&
        (c.args[2] as { doNotContact?: boolean })?.doNotContact === true,
    );
    expect(dncCall).toBeTruthy();
    const row = prisma.scoreStore.get('ws_acme|lead@acme.com');
    expect(row?.disqualified).toBe(true);
    expect(row?.engagementScore).toBe(0);
  });

  it('budget Twenty épuisé (resolve throw) → error, row non marquée poussée', async () => {
    const prisma = makeFakePrisma({ events: hotProspectEvents(), ...fullTenantChain() });
    const crm = makeFakeCrmClient();
    crm.resolvePersonCached.mockRejectedValueOnce(new Error('budget Twenty épuisé'));
    const summary = await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });
    expect(summary.errors).toBe(1);
    expect(summary.pushed).toBe(0);
    const row = prisma.scoreStore.get('ws_acme|lead@acme.com');
    expect(row?.crmPushedScore).toBeNull(); // jamais marquée → re-tentée au prochain tick
  });

  it('reset le token bucket Twenty en début de run', async () => {
    const prisma = makeFakePrisma({ events: hotProspectEvents(), ...fullTenantChain() });
    const crm = makeFakeCrmClient();
    await pushProspectScores({
      prisma: prisma as never,
      crmClient: crm as never,
      now: () => NOW,
      dryRun: false,
    });
    expect(crm.resetWriteBudget).toHaveBeenCalledTimes(1);
  });
});

describe('pushDepsFromEnv — config depuis l\'ENV', () => {
  it('DRY_RUN par défaut TRUE (phase bascule), seul CRON_PUSH_DRY_RUN=false l\'active', () => {
    expect(pushDepsFromEnv({} as NodeJS.ProcessEnv).dryRun).toBe(true);
    expect(
      pushDepsFromEnv({ CRON_PUSH_DRY_RUN: 'false' } as unknown as NodeJS.ProcessEnv).dryRun,
    ).toBe(false);
    // Toute autre valeur reste DRY_RUN (fail-safe).
    expect(
      pushDepsFromEnv({ CRON_PUSH_DRY_RUN: 'true' } as unknown as NodeJS.ProcessEnv).dryRun,
    ).toBe(true);
    expect(
      pushDepsFromEnv({ CRON_PUSH_DRY_RUN: 'yes' } as unknown as NodeJS.ProcessEnv).dryRun,
    ).toBe(true);
  });

  it('lit l\'id du moteur depuis PROSPECT_SCORING_ENGINE_ID (défaut tunnel-v2)', () => {
    expect(pushDepsFromEnv({} as NodeJS.ProcessEnv).engineId).toBe('tunnel-v2');
    expect(
      pushDepsFromEnv({ PROSPECT_SCORING_ENGINE_ID: 'custom-x' } as unknown as NodeJS.ProcessEnv)
        .engineId,
    ).toBe('custom-x');
  });
});
