/**
 * Tests POST /api/cron/trial-tick + runTrialTick orchestrateur.
 *
 * Couvre :
 *  - Auth : CRON_SECRET absent → 500, mauvais secret → 401
 *  - Phase activate : eligible <48h no-op, =48h activate + update-plan + email + telegram
 *  - Phase notify : 12j → email envoyé + ending_soon_notified=true
 *  - Phase finalize : trial_active expiré + Stripe sub active → converted (pas de update-plan)
 *  - Phase finalize : trial_active expiré sans sub → expired + update-plan plan=free
 *  - Race condition : SELECT FOR UPDATE SKIP LOCKED → si la même row arrive 2 fois,
 *    une seule activation
 *
 * On mocke `prisma.$queryRaw` + `prisma.tenantTrial.update` + email + telegram
 * + notifuseClient + hasActiveStripeSubForTenant pour piloter la state machine
 * sans toucher au monde.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks Prisma — déclarés AVANT l'import de la route
// ============================================================================

const queryRawMock = vi.fn();
const tenantTrialUpdateMock = vi.fn();
const tenantFindFirstMock = vi.fn();
const tenantFindManyMock = vi.fn();
const subscriptionFindFirstMock = vi.fn();
const subscriptionFindManyMock = vi.fn();
const userFindFirstMock = vi.fn();
const userFindManyMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    tenantTrial: { update: (...args: unknown[]) => tenantTrialUpdateMock(...args) },
    tenant: {
      findFirst: (...args: unknown[]) => tenantFindFirstMock(...args),
      findMany: (...args: unknown[]) => tenantFindManyMock(...args),
    },
    subscription: {
      findFirst: (...args: unknown[]) => subscriptionFindFirstMock(...args),
      findMany: (...args: unknown[]) => subscriptionFindManyMock(...args),
    },
    user: {
      findFirst: (...args: unknown[]) => userFindFirstMock(...args),
      findMany: (...args: unknown[]) => userFindManyMock(...args),
    },
  },
}));

vi.mock('@/lib/notifuse/admin-helpers', () => ({
  buildNotifuseClient: () => ({
    updatePlan: vi.fn(),
  }),
}));

// ============================================================================
// Helpers
// ============================================================================

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const NOW = new Date('2026-06-15T12:00:00.000Z');

beforeEach(() => {
  queryRawMock.mockReset();
  tenantTrialUpdateMock.mockReset();
  tenantFindFirstMock.mockReset();
  tenantFindManyMock.mockReset();
  subscriptionFindFirstMock.mockReset();
  subscriptionFindManyMock.mockReset();
  userFindFirstMock.mockReset();
  userFindManyMock.mockReset();
  // Par défaut, batch resolvers renvoient des listes vides (tenant inconnu).
  // Les tests qui ont besoin d'un email/sub spécifique override avec
  // mockResolvedValue/mockResolvedValueOnce.
  tenantFindManyMock.mockResolvedValue([]);
  userFindManyMock.mockResolvedValue([]);
  subscriptionFindManyMock.mockResolvedValue([]);
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
  vi.resetModules();
});

function makeRequest(auth: string | null) {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request('http://x/api/cron/trial-tick', {
    method: 'POST',
    headers,
  });
}

// Par défaut, queryRaw renvoie un tableau vide (rien à faire). Les tests
// override avec mockResolvedValueOnce dans l'ordre :
//   1. phase activate (eligible scan)
//   2. phase notify (ending soon scan)
//   3. phase finalize (expired scan)
function setupEmptyScans() {
  queryRawMock
    .mockResolvedValueOnce([]) // activate
    .mockResolvedValueOnce([]) // notify
    .mockResolvedValueOnce([]); // finalize
}

// ============================================================================
// POST handler auth tests
// ============================================================================

describe('POST /api/cron/trial-tick — auth', () => {
  it('returns 500 if CRON_SECRET env missing', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer anything') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cron_not_configured');
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 if wrong secret', async () => {
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('returns 401 if no Authorization header', async () => {
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('returns 200 with summary when secret OK and nothing to do', async () => {
    setupEmptyScans();
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.activated).toBe(0);
    expect(body.notified).toBe(0);
    expect(body.expired).toBe(0);
    expect(body.converted).toBe(0);
  });
});

// ============================================================================
// runTrialTick — phase activate (eligible → trial_active)
// ============================================================================

describe('runTrialTick — phase activate', () => {
  it('no-op when eligible row but cutoff query returns empty (= <48h)', async () => {
    // queryRaw avec eligible_at cutoff doit renvoyer [] si la row est trop
    // récente. C'est PostgreSQL qui filtre, donc côté test on simule juste []
    setupEmptyScans();
    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({ now: NOW });
    expect(summary.activated).toBe(0);
    expect(tenantTrialUpdateMock).not.toHaveBeenCalled();
  });

  it('activates trial when row ≥48h eligible : update state + update-plan pro + email + telegram', async () => {
    queryRawMock
      .mockResolvedValueOnce([
        { tenant_id: 't_42', app: 'notifuse', eligible_at: new Date('2026-06-13T11:00:00Z') },
      ]) // activate
      .mockResolvedValueOnce([]) // notify
      .mockResolvedValueOnce([]); // finalize

    tenantTrialUpdateMock.mockResolvedValue({});
    // Batch resolver tape `tenant.findMany` (puis `user.findMany` si pas
    // de notifuseUserEmail). Ici le tenant a un notifuseUserEmail direct.
    tenantFindManyMock.mockResolvedValue([
      {
        id: 't_42',
        slug: null,
        notifuseWorkspaceSlug: null,
        userId: 'uuid-1',
        notifuseUserEmail: 'owner@example.com',
      },
    ]);

    const updatePlanMock = vi.fn().mockResolvedValue(undefined);
    const sendEmailMock = vi.fn().mockResolvedValue(undefined);
    const notifyTelegramMock = vi.fn().mockResolvedValue(true);
    const hasActiveStripeSubMock = vi.fn().mockResolvedValue(false);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: sendEmailMock,
      notifyTelegram: notifyTelegramMock,
      hasActiveStripeSubForTenant: hasActiveStripeSubMock,
      now: NOW,
    });

    expect(summary.activated).toBe(1);
    expect(summary.errors).toEqual([]);

    // DB updated to trial_active with proper dates
    expect(tenantTrialUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_app: { tenantId: 't_42', app: 'notifuse' } },
        data: expect.objectContaining({
          state: 'trial_active',
          trialStartedAt: NOW,
        }),
      }),
    );
    const updateCall = tenantTrialUpdateMock.mock.calls[0][0];
    // trial_ends_at = NOW + 15j
    expect((updateCall.data.trialEndsAt as Date).toISOString()).toBe(
      '2026-06-30T12:00:00.000Z',
    );

    // Notifuse update-plan called with plan=pro
    expect(updatePlanMock).toHaveBeenCalledWith({ tenantId: 't_42', plan: 'pro' });

    // Email envoyé à l'owner
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@example.com' }),
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/essai Pro/i);

    // Telegram notification fired
    expect(notifyTelegramMock).toHaveBeenCalled();
    expect(notifyTelegramMock.mock.calls[0][0]).toMatch(/Trial Pro activé/);
  });

  it('records error in summary if update-plan throws but does not crash the tick', async () => {
    queryRawMock
      .mockResolvedValueOnce([
        { tenant_id: 't_fail', app: 'notifuse', eligible_at: new Date('2026-06-13T11:00:00Z') },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    tenantTrialUpdateMock.mockResolvedValue({});
    tenantFindFirstMock.mockResolvedValue(null);

    const updatePlanMock = vi.fn().mockRejectedValue(new Error('notifuse down'));
    const { runTrialTick } = await import('@/lib/trial/run-tick');

    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: vi.fn(),
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });

    expect(summary.activated).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].phase).toBe('activate');
    expect(summary.errors[0].error).toMatch(/notifuse down/);
  });

  it('filtre les tenants soft-deleted dans la query SQL (anti-régression E2E Cas 5)', async () => {
    // Anti-régression bug détecté par e2e/staging-full/15-legacy-tenants-paths
    // Cas 5 + ticket 2026-05-22-trial-tick-filtre-soft-deleted.md.
    // Le bug : trial-tick activait/notifiait/expirait des trials sur des
    // tenants dont t.deleted_at IS NOT NULL → mails honteux + Telegram
    // bruyant + update-plan inutile sur workspace mort.
    setupEmptyScans();
    const { runTrialTick } = await import('@/lib/trial/run-tick');
    await runTrialTick({ now: NOW });

    // Les 3 phases utilisent $queryRaw. Vérifier que les 3 calls ont bien
    // le filtre soft-deleted (EXISTS ... deleted_at IS NULL).
    expect(queryRawMock).toHaveBeenCalledTimes(3);
    for (const call of queryRawMock.mock.calls) {
      // Prisma.sql wrappe le template en objet avec strings/values.
      // On reconstruit la query exécutée pour la vérification.
      const sqlObj = call[0] as { strings?: readonly string[]; sql?: string };
      const sqlString = sqlObj.strings
        ? sqlObj.strings.join('')
        : (sqlObj.sql ?? String(sqlObj));
      expect(sqlString).toMatch(/EXISTS/);
      expect(sqlString).toMatch(/hub_app\.tenants/);
      expect(sqlString).toMatch(/deleted_at IS NULL/);
    }
  });
});

// ============================================================================
// runTrialTick — phase notify (J+12)
// ============================================================================

describe('runTrialTick — phase notify ending soon', () => {
  it('sends email + sets ending_soon_notified=true on trial_active rows from scan', async () => {
    queryRawMock
      .mockResolvedValueOnce([]) // activate
      .mockResolvedValueOnce([
        {
          tenant_id: 't_12d',
          app: 'notifuse',
          trial_ends_at: new Date('2026-06-18T12:00:00Z'),
        },
      ]) // notify
      .mockResolvedValueOnce([]); // finalize

    tenantTrialUpdateMock.mockResolvedValue({});
    tenantFindManyMock.mockResolvedValue([
      {
        id: 't_12d',
        slug: null,
        notifuseWorkspaceSlug: null,
        userId: 'uuid-x',
        notifuseUserEmail: 'soon@example.com',
      },
    ]);

    const sendEmailMock = vi.fn().mockResolvedValue(undefined);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: vi.fn() } as never,
      sendEmail: sendEmailMock,
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });

    expect(summary.notified).toBe(1);
    expect(tenantTrialUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_app: { tenantId: 't_12d', app: 'notifuse' } },
        data: expect.objectContaining({ endingSoonNotified: true }),
      }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'soon@example.com' }),
    );
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/3 jours/i);
  });

  it('does not notify if scan returns empty (= already notified or <12d, PG filters)', async () => {
    setupEmptyScans();
    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      sendEmail: vi.fn(),
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      notifuseClient: { updatePlan: vi.fn() } as never,
      now: NOW,
    });
    expect(summary.notified).toBe(0);
  });
});

// ============================================================================
// runTrialTick — phase finalize (J+15)
// ============================================================================

describe('runTrialTick — phase finalize', () => {
  it('marks converted (no downgrade) when Stripe sub is active', async () => {
    queryRawMock
      .mockResolvedValueOnce([]) // activate
      .mockResolvedValueOnce([]) // notify
      .mockResolvedValueOnce([
        {
          tenant_id: 't_paid',
          app: 'notifuse',
          trial_ends_at: new Date('2026-06-15T11:00:00Z'),
        },
      ]); // finalize

    tenantTrialUpdateMock.mockResolvedValue({});
    const updatePlanMock = vi.fn();

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: vi.fn(),
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(true),
      now: NOW,
    });

    expect(summary.converted).toBe(1);
    expect(summary.expired).toBe(0);
    expect(tenantTrialUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'converted' }),
      }),
    );
    // PAS d'update-plan ni d'email expired → Stripe sub gère
    expect(updatePlanMock).not.toHaveBeenCalled();
  });

  it('downgrades to free + email expired when no Stripe sub', async () => {
    queryRawMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          tenant_id: 't_expired',
          app: 'notifuse',
          trial_ends_at: new Date('2026-06-15T11:00:00Z'),
        },
      ]);

    tenantTrialUpdateMock.mockResolvedValue({});
    tenantFindManyMock.mockResolvedValue([
      {
        id: 't_expired',
        slug: null,
        notifuseWorkspaceSlug: null,
        userId: 'uuid-z',
        notifuseUserEmail: 'expired@example.com',
      },
    ]);

    const updatePlanMock = vi.fn().mockResolvedValue(undefined);
    const sendEmailMock = vi.fn().mockResolvedValue(undefined);
    const notifyTelegramMock = vi.fn().mockResolvedValue(true);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: sendEmailMock,
      notifyTelegram: notifyTelegramMock,
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });

    expect(summary.expired).toBe(1);
    expect(summary.converted).toBe(0);
    expect(tenantTrialUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'expired', expiredAt: NOW }),
      }),
    );
    expect(updatePlanMock).toHaveBeenCalledWith({
      tenantId: 't_expired',
      plan: 'free',
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'expired@example.com' }),
    );
    expect(notifyTelegramMock).toHaveBeenCalled();
    expect(notifyTelegramMock.mock.calls[0][0]).toMatch(/Trial expiré/);
  });
});

// ============================================================================
// Race condition : SELECT FOR UPDATE SKIP LOCKED
// ============================================================================

describe('runTrialTick — race condition simulation', () => {
  it('two parallel ticks on the same row : only the one that locks first activates', async () => {
    // On simule le comportement PG : la 2e instance qui scan voit la row déjà
    // verrouillée (SKIP LOCKED → row absente du résultat).
    // Tick 1 scan → renvoie la row
    queryRawMock
      .mockResolvedValueOnce([
        { tenant_id: 't_race', app: 'notifuse', eligible_at: new Date('2026-06-13T11:00:00Z') },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    tenantTrialUpdateMock.mockResolvedValue({});
    tenantFindFirstMock.mockResolvedValue(null);
    const updatePlanMock = vi.fn().mockResolvedValue(undefined);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary1 = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: vi.fn(),
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });
    expect(summary1.activated).toBe(1);

    // Tick 2 (instance parallèle) : scan retourne [] car PG SKIP LOCKED
    vi.resetModules();
    queryRawMock.mockReset();
    setupEmptyScans();
    const { runTrialTick: runAgain } = await import('@/lib/trial/run-tick');
    const summary2 = await runAgain({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: vi.fn(),
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });

    expect(summary2.activated).toBe(0);
    // Total : 1 seule activation, 1 seul appel update-plan
    expect(updatePlanMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Batch resolvers (fix N+1) — vérifier que les helpers tapent la DB en
// 2 queries (au lieu de N×2) pour un batch de plusieurs rows.
//
// Cf ticket todo/2026-05-21-fix-n1-trial-tick.md.
// ============================================================================

describe('runTrialTick — batch resolvers (N+1 fix)', () => {
  it('phase activate : 50 rows → 1 seul tenant.findMany + 1 seul user.findMany (au lieu de 50×2)', async () => {
    // Construit 50 rows eligible synthétiques.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      tenant_id: `t_${i}`,
      app: 'notifuse',
      eligible_at: new Date('2026-06-13T11:00:00Z'),
    }));
    queryRawMock
      .mockResolvedValueOnce(rows) // activate
      .mockResolvedValueOnce([]) // notify
      .mockResolvedValueOnce([]); // finalize

    tenantTrialUpdateMock.mockResolvedValue({});

    // Le batch resolver tape `tenant.findMany` une fois pour les 50 IDs.
    // Sur ces 50 tenants, certains ont notifuseUserEmail direct (pas de
    // user.findMany), d'autres non (déclenchent user.findMany).
    const tenantRows = rows.map((r, i) => ({
      id: r.tenant_id,
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: `uuid-${i}`,
      // 25 ont email direct, 25 doivent passer par user.findMany
      notifuseUserEmail: i % 2 === 0 ? `direct${i}@example.com` : null,
    }));
    tenantFindManyMock.mockResolvedValueOnce(tenantRows);
    userFindManyMock.mockResolvedValueOnce(
      tenantRows
        .filter((t) => !t.notifuseUserEmail)
        .map((t) => ({ supabaseUserId: t.userId, email: `user${t.userId}@example.com` })),
    );

    const updatePlanMock = vi.fn().mockResolvedValue(undefined);
    const sendEmailMock = vi.fn().mockResolvedValue(undefined);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: sendEmailMock,
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });

    expect(summary.activated).toBe(50);
    expect(summary.errors).toEqual([]);

    // GAIN PERF — c'est le point central du fix :
    //   - 1 seul tenant.findMany (au lieu de 50 tenant.findFirst)
    //   - 1 seul user.findMany (au lieu de 25 user.findFirst)
    //   - 0 tenant.findFirst (le helper legacy n'est plus appelé)
    expect(tenantFindManyMock).toHaveBeenCalledTimes(1);
    expect(userFindManyMock).toHaveBeenCalledTimes(1);
    expect(tenantFindFirstMock).not.toHaveBeenCalled();
    expect(userFindFirstMock).not.toHaveBeenCalled();

    // L'appel tenant.findMany contient bien tous les 50 IDs en une seule
    // requête (WHERE IN).
    const tenantFindCall = tenantFindManyMock.mock.calls[0][0];
    expect(tenantFindCall.where.OR).toBeDefined();
    // Tous les 50 sont du format non-UUID → vont dans la branche slug/notifuse.
    const allIds = rows.map((r) => r.tenant_id);
    const orClause = tenantFindCall.where.OR as Array<{
      notifuseWorkspaceSlug?: { in: string[] };
      slug?: { in: string[] };
    }>;
    const inLists = orClause.flatMap((c) =>
      c.notifuseWorkspaceSlug?.in ?? c.slug?.in ?? [],
    );
    for (const id of allIds) {
      expect(inLists).toContain(id);
    }

    // Vérif sémantique : tous les emails sont bien arrivés (24 directs + 25
    // via user — total = 50 sendEmail calls).
    expect(sendEmailMock).toHaveBeenCalledTimes(50);
  });

  it('phase finalize : batch de 30 rows → 1 tenant.findMany + 1 subscription.findMany pour la résolution Stripe', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      tenant_id: `t_fin_${i}`,
      app: 'notifuse',
      trial_ends_at: new Date('2026-06-15T11:00:00Z'),
    }));
    queryRawMock
      .mockResolvedValueOnce([]) // activate
      .mockResolvedValueOnce([]) // notify
      .mockResolvedValueOnce(rows); // finalize

    tenantTrialUpdateMock.mockResolvedValue({});

    // Le batch resolver email + le batch resolver Stripe sub partagent
    // PAS leur query tenant.findMany (chacun fait la sienne) — 2 calls
    // attendus sur tenant.findMany sur la phase finalize.
    const tenantRows = rows.map((r, i) => ({
      id: r.tenant_id,
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: `uuid-fin-${i}`,
      notifuseUserEmail: `fin${i}@example.com`,
    }));
    // 1er appel : depuis defaultBatchResolveOwnerEmails
    // 2e appel : depuis defaultBatchResolveHasActiveSub
    tenantFindManyMock.mockResolvedValue(tenantRows);

    // 10 des 30 tenants ont une Stripe sub active (→ converted),
    // 20 n'en ont pas (→ expired + downgrade).
    const activeUserIds = tenantRows.slice(0, 10).map((t) => t.userId);
    subscriptionFindManyMock.mockResolvedValueOnce(
      activeUserIds.map((uid) => ({ userId: uid })),
    );

    const updatePlanMock = vi.fn().mockResolvedValue(undefined);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: vi.fn().mockResolvedValue(undefined),
      notifyTelegram: vi.fn().mockResolvedValue(true),
      // PAS de hasActiveStripeSubForTenant → on prend la voie batch DB.
      now: NOW,
    });

    expect(summary.converted).toBe(10);
    expect(summary.expired).toBe(20);
    expect(summary.errors).toEqual([]);

    // GAIN PERF : 2 tenant.findMany (1 pour emails, 1 pour subs) au lieu
    // de 30 × 2 = 60 tenant.findFirst.
    expect(tenantFindManyMock).toHaveBeenCalledTimes(2);
    // 1 seul subscription.findMany au lieu de 30 subscription.findFirst.
    expect(subscriptionFindManyMock).toHaveBeenCalledTimes(1);
    expect(subscriptionFindFirstMock).not.toHaveBeenCalled();
    expect(tenantFindFirstMock).not.toHaveBeenCalled();

    // Seuls les 20 expired déclenchent update-plan plan=free.
    expect(updatePlanMock).toHaveBeenCalledTimes(20);
    for (const call of updatePlanMock.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({ plan: 'free' }),
      );
    }
  });

  it('batch resolvers déduplique les tenant_id en doublon dans le WHERE IN (cas multi-app par tenant)', async () => {
    // Cas réel : un tenant peut avoir un trial actif sur Notifuse ET sur
    // Prospection — 2 rows tenant_trials différentes, même `tenant_id`.
    // Le batch resolver doit dédup avant de lancer la query SQL, sinon le
    // WHERE IN contient des doublons inutiles (perf marginale) ET ça
    // valide que l'opérateur `new Set(...)` + `Array.from(...)` (refacto
    // TS es5) fonctionne comme attendu.
    const rows = [
      { tenant_id: 'shared_tenant', app: 'notifuse', eligible_at: new Date('2026-06-13T11:00:00Z') },
      { tenant_id: 'shared_tenant', app: 'prospection', eligible_at: new Date('2026-06-13T11:00:00Z') },
      { tenant_id: 'other_tenant', app: 'notifuse', eligible_at: new Date('2026-06-13T11:00:00Z') },
    ];
    queryRawMock
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    tenantTrialUpdateMock.mockResolvedValue({});
    tenantFindManyMock.mockResolvedValue([
      {
        id: 'shared_tenant',
        slug: null,
        notifuseWorkspaceSlug: null,
        userId: 'uuid-shared',
        notifuseUserEmail: 'shared@example.com',
      },
      {
        id: 'other_tenant',
        slug: null,
        notifuseWorkspaceSlug: null,
        userId: 'uuid-other',
        notifuseUserEmail: 'other@example.com',
      },
    ]);

    const updatePlanMock = vi.fn().mockResolvedValue(undefined);
    const sendEmailMock = vi.fn().mockResolvedValue(undefined);

    const { runTrialTick } = await import('@/lib/trial/run-tick');
    const summary = await runTrialTick({
      notifuseClient: { updatePlan: updatePlanMock } as never,
      sendEmail: sendEmailMock,
      notifyTelegram: vi.fn().mockResolvedValue(true),
      hasActiveStripeSubForTenant: vi.fn().mockResolvedValue(false),
      now: NOW,
    });

    // 3 activations totales (1 row par couple tenant/app).
    expect(summary.activated).toBe(3);
    expect(summary.errors).toEqual([]);

    // 1 seul tenant.findMany pour la phase activate.
    expect(tenantFindManyMock).toHaveBeenCalledTimes(1);

    // VRAIE vérif dédup : la liste passée dans le WHERE IN ne doit pas
    // contenir 'shared_tenant' deux fois.
    const findCall = tenantFindManyMock.mock.calls[0][0];
    const orClauses = findCall.where.OR as Array<{
      notifuseWorkspaceSlug?: { in: string[] };
      slug?: { in: string[] };
      id?: { in: string[] };
    }>;
    const allInValues = orClauses.flatMap((c) =>
      [...(c.id?.in ?? []), ...(c.notifuseWorkspaceSlug?.in ?? []), ...(c.slug?.in ?? [])],
    );
    const sharedCount = allInValues.filter((v) => v === 'shared_tenant').length;
    // 'shared_tenant' apparaît dans 2 branches (slug + notifuseWorkspaceSlug)
    // mais JAMAIS 2 fois dans la même branche → dédup respecté.
    for (const clause of orClauses) {
      const values =
        clause.id?.in ?? clause.notifuseWorkspaceSlug?.in ?? clause.slug?.in ?? [];
      expect(new Set(values).size).toBe(values.length); // unique dans chaque branche
    }
    // Présent dans 2 branches (slug + notifuseWorkspaceSlug) car non-UUID.
    expect(sharedCount).toBe(2);

    // 3 emails envoyés (2 pour shared via les 2 apps, 1 pour other).
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
  });
});
