/**
 * Test smoke pour POST /api/webhooks Stripe (refacto 2026-05-18).
 *
 * Vérifie :
 *   1. 400 si signature manquante / secret manquant
 *   2. 400 si signature invalide
 *   3. 200 + ignored si event hors whitelist → persist + markEventProcessed(ok:true)
 *   4. 200 si event subscription valide → appelle manageSubscriptionStatusChange
 *      + markEventProcessed(ok:true) + PAS d'alerte Telegram
 *   5. 200 si checkout.session.completed avec subscription → idem
 *   6. 200 (avec outcome=failed) si handler throw → ASSERTIONS FORTES :
 *      a) markEventProcessed appelé avec error: 'DB down' (signal côté DB)
 *      b) sendTelegramAlert appelé avec message d'erreur (signal opérationnel)
 *      Ces assertions garantissent que si quelqu'un retire le signalement
 *      d'erreur côté code applicatif, le test casse.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const constructEventMock = vi.fn();
vi.mock('@/utils/stripe/config', () => ({
  stripe: {
    webhooks: { constructEvent: (...args: any[]) => constructEventMock(...args) },
  },
}));

vi.mock('@/utils/env', () => ({
  getStripeWebhookSecret: () => 'whsec_test_secret',
  getEnvironmentLabel: () => 'test',
}));

const manageSubscriptionMock = vi.fn();
vi.mock('@/utils/stripe/prisma-sync', () => ({
  manageSubscriptionStatusChange: (...args: any[]) => manageSubscriptionMock(...args),
}));

// Mock Telegram → on veut SPY que l'alerte est levée quand le dispatcher catch
// un throw. C'est le signal opérationnel le plus critique : si Robert n'est
// pas notifié, une désync billing peut traîner des jours sans détection.
const sendTelegramAlertMock = vi.fn(async () => true);
vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: any[]) => sendTelegramAlertMock(...args),
}));

// Mock Prisma → on veut SPY que stripeEvent.update est appelé avec un `error`
// non-null en cas de failure (markEventProcessed côté DB). Sans ce mock, le
// vrai client Prisma plante au runtime et l'erreur est swallowed par le
// try/catch non-bloquant de la route → on perd la trace du signal.
const prismaStripeEventFindUnique = vi.fn(async () => null); // event jamais vu
const prismaStripeEventCreate = vi.fn(async () => ({ eventId: 'mock' }));
const prismaStripeEventUpdate = vi.fn(async () => ({ eventId: 'mock' }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    stripeEvent: {
      findUnique: (...args: any[]) => prismaStripeEventFindUnique(...args),
      create: (...args: any[]) => prismaStripeEventCreate(...args),
      update: (...args: any[]) => prismaStripeEventUpdate(...args),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset au default "happy path" : pas de failure de propagation
  manageSubscriptionMock.mockResolvedValue({
    tenantId: 'tenant_test',
    applied: [{ app: 'notifuse', targetPlan: 'pro', immune: false }],
    failures: [],
  });
  prismaStripeEventFindUnique.mockResolvedValue(null);
});

function makeReq(body: string, sig: string | null) {
  return {
    text: async () => body,
    headers: { get: (k: string) => (k === 'stripe-signature' ? sig : null) },
  } as any;
}

describe('POST /api/webhooks (Stripe)', () => {
  it('returns 400 if signature header is missing', async () => {
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', null));
    expect(res.status).toBe(400);
  });

  it('returns 400 if signature verification fails', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'bad_sig'));
    expect(res.status).toBe(400);
  });

  it('returns 200 + ignored for irrelevant event (e.g. product.created)', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'product.created',
      data: { object: {} },
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('ignored');
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
    // Même pour un event ignored, on persiste pour idempotence (Stripe peut
    // retry) et on marque processedAt → sinon le cron retry-failed le re-pickerait.
    expect(prismaStripeEventCreate).toHaveBeenCalledOnce();
    expect(prismaStripeEventUpdate).toHaveBeenCalledWith({
      where: { eventId: 'evt_1' },
      data: { processedAt: expect.any(Date), error: null },
    });
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('handles customer.subscription.created → calls handler + marks processed', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_2',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Renforcement vs ancienne version : on vérifie l'outcome processed pour
    // attraper le faux-green où manageSubscriptionMock retournait undefined
    // et le dispatcher throwait silencieusement sur .failures.
    expect(body.outcome).toBe('processed');
    expect(manageSubscriptionMock).toHaveBeenCalledWith(
      'sub_1',
      'cus_1',
      true,
      expect.any(Object),
    );
    // Le succès doit marquer processedAt non-null + error=null
    expect(prismaStripeEventUpdate).toHaveBeenCalledWith({
      where: { eventId: 'evt_2' },
      data: { processedAt: expect.any(Date), error: null },
    });
    // Happy path : pas d'alerte Telegram
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('handles checkout.session.completed (mode=subscription) → calls handler + marks processed', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          subscription: 'sub_2',
          customer: 'cus_2',
        },
      },
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('processed');
    expect(manageSubscriptionMock).toHaveBeenCalledWith(
      'sub_2',
      'cus_2',
      true,
      expect.any(Object),
    );
    expect(prismaStripeEventUpdate).toHaveBeenCalledWith({
      where: { eventId: 'evt_3' },
      data: { processedAt: expect.any(Date), error: null },
    });
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('returns 200 (with failed outcome) if handler throws — signals error via Telegram + stripe_events.error', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_3', customer: 'cus_3' } },
    });
    manageSubscriptionMock.mockRejectedValueOnce(new Error('DB down'));
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));

    // 1) Comportement métier : 200 à Stripe pour éviter retry inutiles,
    //    outcome=failed pour traçabilité côté caller.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('failed');

    // 2) SIGNAL CRITIQUE A — alerte Telegram envoyée. C'est ce que Robert
    //    voit dans son Telegram quand un webhook plante. Si on perd ce
    //    signal, on peut traîner une désync billing des jours sans
    //    s'en apercevoir → test doit casser si le dispatcher arrête
    //    d'appeler alertFn dans le catch.
    expect(sendTelegramAlertMock).toHaveBeenCalledTimes(1);
    const alertMessage = sendTelegramAlertMock.mock.calls[0][0] as string;
    expect(alertMessage).toContain('Stripe webhook dispatcher KO');
    expect(alertMessage).toContain('customer.subscription.deleted');
    expect(alertMessage).toContain('evt_4');
    expect(alertMessage).toContain('DB down');

    // 3) SIGNAL CRITIQUE B — l'event est marqué `error` non-null dans
    //    stripe_events. C'est ce que lira le cron retry-failed (P2) et le
    //    dashboard admin pour voir le backlog. Si on perd ce signal, les
    //    events failed sont indistinguables des events en cours et le
    //    cron ne pourra plus les replay.
    expect(prismaStripeEventUpdate).toHaveBeenCalledWith({
      where: { eventId: 'evt_4' },
      data: {
        error: 'DB down',
        attempts: { increment: 1 },
      },
    });
    // L'update de failure NE DOIT PAS poser processedAt (sinon le cron
    // retry-failed considèrerait l'event comme terminé).
    const failureUpdateCall = prismaStripeEventUpdate.mock.calls.find(
      (c: any) => c[0]?.data?.error === 'DB down',
    );
    expect(failureUpdateCall).toBeDefined();
    expect(failureUpdateCall![0].data).not.toHaveProperty('processedAt');
  });
});
