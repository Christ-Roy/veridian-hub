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
const subscriptionFindFirstMock = vi.fn();
const userFindFirstMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    tenantTrial: { update: (...args: unknown[]) => tenantTrialUpdateMock(...args) },
    tenant: { findFirst: (...args: unknown[]) => tenantFindFirstMock(...args) },
    subscription: { findFirst: (...args: unknown[]) => subscriptionFindFirstMock(...args) },
    user: { findFirst: (...args: unknown[]) => userFindFirstMock(...args) },
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
  subscriptionFindFirstMock.mockReset();
  userFindFirstMock.mockReset();
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
    tenantFindFirstMock.mockResolvedValue({
      userId: 'uuid-1',
      notifuseUserEmail: 'owner@example.com',
    });

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
    tenantFindFirstMock.mockResolvedValue({
      userId: 'uuid-x',
      notifuseUserEmail: 'soon@example.com',
    });

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
    tenantFindFirstMock.mockResolvedValue({
      userId: 'uuid-z',
      notifuseUserEmail: 'expired@example.com',
    });

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
