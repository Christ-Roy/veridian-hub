/**
 * Tests `lib/billing/refill-leads.ts` — couvre la logique pure :
 *   - mapping plans Hub↔Prospection
 *   - welcome leads lookup (depuis shared catalogue)
 *   - calcul de delta upgrade
 *   - idempotency keys déterministes + format UUID v4 valide
 *   - calcul de prix (wrappant calculateRefillCostCents shared)
 *   - dispatcher purchase / welcome (retry, idempotency, 4xx no-retry, 5xx retry)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  mapHubTierToProspectionPlan,
  mapProspectionPlanToRefillTier,
  getWelcomeLeadsForProspectionPlan,
  computeWelcomeLeadsDelta,
  deterministicUuid,
  purchaseIdempotencyKey,
  welcomeIdempotencyKey,
  checkoutSeedIdempotencyKey,
  priceRefillCents,
  RefillQuantityError,
  CreditLeadsClient,
  CreditLeadsError,
  dispatchRefillPurchase,
  dispatchRefillWelcome,
  REFILL_CONTRACT_VERSION,
  REFILL_DISPATCH_MAX_RETRIES,
  type ProspectionLocalPlan,
} from '@/lib/billing/refill-leads';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('mapHubTierToProspectionPlan', () => {
  it('mappe `free` → `freemium`', () => {
    expect(mapHubTierToProspectionPlan('free')).toBe('freemium');
  });
  it('mappe `pro` → `pro`', () => {
    expect(mapHubTierToProspectionPlan('pro')).toBe('pro');
  });
  it('mappe `business` → `business`', () => {
    expect(mapHubTierToProspectionPlan('business')).toBe('business');
  });
  it('mappe `enterprise` → `business` (pas de palier enterprise local)', () => {
    expect(mapHubTierToProspectionPlan('enterprise')).toBe('business');
  });
});

describe('mapProspectionPlanToRefillTier', () => {
  it('passthrough — les enums coïncident', () => {
    expect(mapProspectionPlanToRefillTier('freemium')).toBe('freemium');
    expect(mapProspectionPlanToRefillTier('pro')).toBe('pro');
    expect(mapProspectionPlanToRefillTier('business')).toBe('business');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Welcome leads lookup + delta
// ─────────────────────────────────────────────────────────────────────────────

describe('getWelcomeLeadsForProspectionPlan', () => {
  it('retourne 100 pour freemium (PRICING-VERIDIAN §78)', () => {
    expect(getWelcomeLeadsForProspectionPlan('freemium')).toBe(100);
  });
  it('retourne 2000 pour pro', () => {
    expect(getWelcomeLeadsForProspectionPlan('pro')).toBe(2000);
  });
  it('retourne 8000 pour business', () => {
    expect(getWelcomeLeadsForProspectionPlan('business')).toBe(8000);
  });
});

describe('computeWelcomeLeadsDelta', () => {
  it('renvoie le total si pas d\'ancien plan (provisioning initial)', () => {
    expect(computeWelcomeLeadsDelta(null, 'freemium')).toBe(100);
    expect(computeWelcomeLeadsDelta(null, 'pro')).toBe(2000);
  });

  it('renvoie le delta sur upgrade freemium → pro (1900)', () => {
    expect(computeWelcomeLeadsDelta('freemium', 'pro')).toBe(1900);
  });

  it('renvoie le delta sur upgrade pro → business (6000)', () => {
    expect(computeWelcomeLeadsDelta('pro', 'business')).toBe(6000);
  });

  it('renvoie le delta sur upgrade direct freemium → business (7900)', () => {
    expect(computeWelcomeLeadsDelta('freemium', 'business')).toBe(7900);
  });

  it('renvoie 0 sur downgrade business → pro (leads permanents §97)', () => {
    expect(computeWelcomeLeadsDelta('business', 'pro')).toBe(0);
  });

  it('renvoie 0 sur downgrade pro → freemium', () => {
    expect(computeWelcomeLeadsDelta('pro', 'freemium')).toBe(0);
  });

  it('renvoie 0 sur même palier (no-op)', () => {
    expect(computeWelcomeLeadsDelta('pro', 'pro')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency keys — DÉTERMINISTES + format UUID v4 valide
// ─────────────────────────────────────────────────────────────────────────────

describe('deterministicUuid', () => {
  it('produit une string au format UUID v4 valide', () => {
    const key = deterministicUuid('test-seed');
    expect(key).toMatch(UUID_V4_REGEX);
  });

  it('est DÉTERMINISTE — même seed = même UUID', () => {
    expect(deterministicUuid('abc')).toBe(deterministicUuid('abc'));
  });

  it('produit des UUIDs différents pour des seeds différents', () => {
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
  });
});

describe('purchaseIdempotencyKey', () => {
  it('dérive le même UUID pour un event Stripe rejoué (retry safe)', () => {
    const k1 = purchaseIdempotencyKey('evt_1abc');
    const k2 = purchaseIdempotencyKey('evt_1abc');
    expect(k1).toBe(k2);
    expect(k1).toMatch(UUID_V4_REGEX);
  });

  it('produit un UUID différent par event id distinct', () => {
    expect(purchaseIdempotencyKey('evt_a')).not.toBe(purchaseIdempotencyKey('evt_b'));
  });

  it('isolé du namespace welcome — même seed brut produit des UUIDs différents', () => {
    // purchase("xyz") vs welcome("xyz", "pro") doivent diverger
    expect(purchaseIdempotencyKey('xyz')).not.toBe(
      welcomeIdempotencyKey('xyz', 'pro'),
    );
  });
});

describe('welcomeIdempotencyKey', () => {
  it('même tenant + même plan → même UUID (1 grant par palier garanti)', () => {
    const k1 = welcomeIdempotencyKey('tenant-1', 'pro');
    const k2 = welcomeIdempotencyKey('tenant-1', 'pro');
    expect(k1).toBe(k2);
  });

  it('même tenant + plans différents → UUIDs différents', () => {
    expect(welcomeIdempotencyKey('t', 'freemium')).not.toBe(
      welcomeIdempotencyKey('t', 'pro'),
    );
  });

  it('tenants différents + même plan → UUIDs différents', () => {
    expect(welcomeIdempotencyKey('t1', 'pro')).not.toBe(
      welcomeIdempotencyKey('t2', 'pro'),
    );
  });
});

describe('checkoutSeedIdempotencyKey', () => {
  it('même tenant + qty + seconde → même UUID (refresh page pas une 2e session)', () => {
    const k1 = checkoutSeedIdempotencyKey('t', 500, 1716000000);
    const k2 = checkoutSeedIdempotencyKey('t', 500, 1716000000);
    expect(k1).toBe(k2);
  });

  it('seconde différente → UUIDs différents', () => {
    expect(checkoutSeedIdempotencyKey('t', 500, 1)).not.toBe(
      checkoutSeedIdempotencyKey('t', 500, 2),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calcul de prix
// ─────────────────────────────────────────────────────────────────────────────

describe('priceRefillCents', () => {
  it('throw RefillQuantityError sur quantity < 1', () => {
    expect(() => priceRefillCents('pro', 0)).toThrow(RefillQuantityError);
    expect(() => priceRefillCents('pro', -5)).toThrow(RefillQuantityError);
  });

  it('throw RefillQuantityError sur quantity > MAX (100000)', () => {
    expect(() => priceRefillCents('business', 100_001)).toThrow(RefillQuantityError);
  });

  it('throw RefillQuantityError sur quantity non-entière', () => {
    expect(() => priceRefillCents('pro', 1.5)).toThrow(RefillQuantityError);
  });

  it('calcule selon grille freemium tranche 1 (50c/lead × 50)', () => {
    expect(priceRefillCents('freemium', 50)).toBe(2500);
  });

  it('calcule selon grille pro tranche 2 (25c/lead × 500)', () => {
    expect(priceRefillCents('pro', 500)).toBe(12_500);
  });

  it('calcule selon grille business tranche 4 (6c/lead × 20000)', () => {
    expect(priceRefillCents('business', 20_000)).toBe(120_000);
  });

  it('calcule selon grille business tranche 5 (4c/lead × 100000)', () => {
    expect(priceRefillCents('business', 100_000)).toBe(400_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CreditLeadsClient — HMAC + fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('CreditLeadsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throw si apiUrl manquant', () => {
    expect(
      () => new CreditLeadsClient({ apiUrl: '', hubSecret: 's' }),
    ).toThrow(/apiUrl required/);
  });

  it('throw si hubSecret manquant', () => {
    expect(
      () => new CreditLeadsClient({ apiUrl: 'https://x', hubSecret: '' }),
    ).toThrow(/hubSecret required/);
  });

  it('signe le body avec HMAC SHA256 et envoie les bons headers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ credited: 100, balance: 100 }),
    } as unknown as Response));

    const client = new CreditLeadsClient({
      apiUrl: 'https://prospection.test',
      hubSecret: 'top-secret',
      fetchImpl: fetchMock,
    });

    const body = {
      quantity: 100,
      source: 'purchase' as const,
      stripe_payment_id: 'pi_x',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
      contract_version: REFILL_CONTRACT_VERSION,
    };
    const resp = await client.creditLeads('tenant-id', body);

    expect(resp).toEqual({ credited: 100, balance: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('https://prospection.test/api/tenants/tenant-id/credit-leads');
    const init = callArgs[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(body));
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Veridian-Timestamp']).toMatch(/^\d+$/);
    // 64 hex = SHA-256
    expect(headers['X-Veridian-Hub-Signature']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('encode le tenantIdOrEmail dans le path (emails contiennent @)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as unknown as Response));

    const client = new CreditLeadsClient({
      apiUrl: 'https://prospection.test',
      hubSecret: 's',
      fetchImpl: fetchMock,
    });
    await client.creditLeads('owner@veridian.site', {
      quantity: 1,
      source: 'welcome',
      welcome_plan: 'freemium',
      idempotency_key: '22222222-2222-4222-8222-222222222222',
      contract_version: REFILL_CONTRACT_VERSION,
    });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('owner%40veridian.site');
  });

  it('throw CreditLeadsError sur HTTP 404', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'tenant_not_found' }),
    } as unknown as Response));

    const client = new CreditLeadsClient({
      apiUrl: 'https://prospection.test',
      hubSecret: 's',
      fetchImpl: fetchMock,
    });

    await expect(
      client.creditLeads('missing', {
        quantity: 1,
        source: 'welcome',
        welcome_plan: 'freemium',
        idempotency_key: '33333333-3333-4333-8333-333333333333',
        contract_version: REFILL_CONTRACT_VERSION,
      }),
    ).rejects.toMatchObject({
      name: 'CreditLeadsError',
      status: 404,
    });
  });

  it('throw CreditLeadsError sur timeout', async () => {
    // fetch ne résout jamais → AbortController kick in
    const fetchMock = vi.fn(
      (_: string | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );

    const client = new CreditLeadsClient({
      apiUrl: 'https://prospection.test',
      hubSecret: 's',
      timeoutMs: 50,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.creditLeads('t', {
        quantity: 1,
        source: 'welcome',
        welcome_plan: 'freemium',
        idempotency_key: '44444444-4444-4444-8444-444444444444',
        contract_version: REFILL_CONTRACT_VERSION,
      }),
    ).rejects.toMatchObject({ name: 'CreditLeadsError', status: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher (retry exponentiel) — purchase + welcome
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchRefillPurchase — retry policy', () => {
  const fakeSleep = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeClient(responses: Array<() => Promise<unknown>>) {
    let call = 0;
    return {
      creditLeads: vi.fn(async () => {
        const fn = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return fn();
      }),
    } as unknown as CreditLeadsClient;
  }

  it('success au 1er essai → ok:true attempts:1, idempotency_key dérivé de event.id', async () => {
    const client = makeClient([async () => ({ credited: 500, balance: 500 })]);
    const result = await dispatchRefillPurchase(
      client,
      {
        tenantIdOrEmail: 'u@v.site',
        quantity: 500,
        stripeEventId: 'evt_test_1',
        stripePaymentId: 'pi_test_1',
      },
      { sleep: fakeSleep },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.attempts).toBe(1);
    expect(fakeSleep).not.toHaveBeenCalled();

    // Vérifie le body envoyé
    const body = (client.creditLeads as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(body.quantity).toBe(500);
    expect(body.source).toBe('purchase');
    expect(body.stripe_payment_id).toBe('pi_test_1');
    expect(body.contract_version).toBe(REFILL_CONTRACT_VERSION);
    // idempotency_key déterministe basé sur stripeEventId
    expect(body.idempotency_key).toBe(purchaseIdempotencyKey('evt_test_1'));
  });

  it('5xx puis success → retry transparent', async () => {
    const client = makeClient([
      async () => { throw new CreditLeadsError('boom', 502, null); },
      async () => ({ credited: 500, balance: 500 }),
    ]);
    const result = await dispatchRefillPurchase(
      client,
      {
        tenantIdOrEmail: 't',
        quantity: 500,
        stripeEventId: 'evt_2',
        stripePaymentId: 'pi_2',
      },
      { sleep: fakeSleep },
    );

    expect(result.ok).toBe(true);
    expect(fakeSleep).toHaveBeenCalledTimes(1);
  });

  it('4xx → AUCUN retry (payload rejeté, re-tenter ne change rien)', async () => {
    const client = makeClient([
      async () => { throw new CreditLeadsError('invalid_body', 422, null); },
    ]);
    const result = await dispatchRefillPurchase(
      client,
      { tenantIdOrEmail: 't', quantity: 1, stripeEventId: 'evt_3', stripePaymentId: 'pi_3' },
      { sleep: fakeSleep },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(422);
    expect(result.attempts).toBe(1);
    expect(fakeSleep).not.toHaveBeenCalled();
    expect((client.creditLeads as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('3 échecs 5xx → ok:false attempts=3, alertable', async () => {
    const client = makeClient([
      async () => { throw new CreditLeadsError('boom', 502, null); },
      async () => { throw new CreditLeadsError('boom', 502, null); },
      async () => { throw new CreditLeadsError('boom', 502, null); },
    ]);
    const result = await dispatchRefillPurchase(
      client,
      { tenantIdOrEmail: 't', quantity: 100, stripeEventId: 'evt_4', stripePaymentId: 'pi_4' },
      { sleep: fakeSleep },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.attempts).toBe(REFILL_DISPATCH_MAX_RETRIES + 1);
    expect(fakeSleep).toHaveBeenCalledTimes(REFILL_DISPATCH_MAX_RETRIES);
  });

  it('retry sur erreur réseau (non-CreditLeadsError) puis success', async () => {
    const client = makeClient([
      async () => { throw new Error('socket reset'); },
      async () => ({ credited: 50 }),
    ]);
    const result = await dispatchRefillPurchase(
      client,
      { tenantIdOrEmail: 't', quantity: 50, stripeEventId: 'evt_5', stripePaymentId: 'pi_5' },
      { sleep: fakeSleep },
    );
    expect(result.ok).toBe(true);
  });
});

describe('dispatchRefillWelcome — idempotency déterministe par palier', () => {
  it('rejoue avec la même idempotency_key sur 2 dispatch (anti-double-grant)', async () => {
    const client = {
      creditLeads: vi.fn(async () => ({ credited: 100, balance: 100 })),
    } as unknown as CreditLeadsClient;

    await dispatchRefillWelcome(client, {
      tenantIdOrEmail: 'u@v',
      quantity: 100,
      welcomePlan: 'freemium',
      keyTenantId: 'tenant-uuid-1',
    });
    await dispatchRefillWelcome(client, {
      tenantIdOrEmail: 'u@v',
      quantity: 100,
      welcomePlan: 'freemium',
      keyTenantId: 'tenant-uuid-1',
    });

    const calls = (client.creditLeads as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const body1 = calls[0][1] as Record<string, unknown>;
    const body2 = calls[1][1] as Record<string, unknown>;
    expect(body1.idempotency_key).toBe(body2.idempotency_key);
    expect(body1.welcome_plan).toBe('freemium');
  });

  it('paliers différents → idempotency_keys différents', async () => {
    const client = {
      creditLeads: vi.fn(async () => ({ credited: 0 })),
    } as unknown as CreditLeadsClient;

    await dispatchRefillWelcome(client, {
      tenantIdOrEmail: 't',
      quantity: 100,
      welcomePlan: 'freemium',
      keyTenantId: 'tenant-1',
    });
    await dispatchRefillWelcome(client, {
      tenantIdOrEmail: 't',
      quantity: 2000,
      welcomePlan: 'pro',
      keyTenantId: 'tenant-1',
    });

    const calls = (client.creditLeads as ReturnType<typeof vi.fn>).mock.calls;
    const body1 = calls[0][1] as Record<string, unknown>;
    const body2 = calls[1][1] as Record<string, unknown>;
    expect(body1.idempotency_key).not.toBe(body2.idempotency_key);
  });

  it('fallback : utilise tenantIdOrEmail comme keyTenantId si non fourni', async () => {
    const client = {
      creditLeads: vi.fn(async () => ({ credited: 100 })),
    } as unknown as CreditLeadsClient;

    await dispatchRefillWelcome(client, {
      tenantIdOrEmail: 'foo@bar',
      quantity: 100,
      welcomePlan: 'freemium',
    });

    const body = (client.creditLeads as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(body.idempotency_key).toBe(
      welcomeIdempotencyKey('foo@bar', 'freemium'),
    );
  });
});
