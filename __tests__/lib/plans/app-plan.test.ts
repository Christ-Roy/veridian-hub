/**
 * Plan d'Analytics et du CRM poussé à l'app (CONTRAT-BILLING §3 v2 + hub_user_id), puis écrit au Hub
 * dans `metadata.<app>_plan`, que reconcile compare. Un refus de l'app n'écrit rien.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { bundleTier, pushAppPlan, readAppPlan, setAppPlan, tenantHasApp } from '@/lib/plans/app-plan';

const env = {
  ANALYTICS_API_URL: 'https://analytics.app.veridian.site/',
  ANALYTICS_HUB_API_SECRET: 'secret-analytics',
  CRM_API_URL: 'https://crm.app.veridian.site',
  CRM_HUB_API_SECRET: 'secret-crm',
} as unknown as NodeJS.ProcessEnv;

const reponse = (status: number, corps: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(corps), { status }));

function fausseBase(metadata: Record<string, unknown> = { analytics: { linked_at: 'x' } }) {
  const ligne = { id: 't-1', userId: 'hub-1', metadata };
  const update = vi.fn(async ({ data }: any) => {
    ligne.metadata = data.metadata;
    return ligne;
  });
  const db = {
    tenant: { findUnique: vi.fn(async () => ligne), update },
    tenantTrial: { findMany: vi.fn(async () => [{ state: 'trial_active', trialEndsAt: new Date('2026-12-01T00:00:00Z') }]) },
    subscription: { findMany: vi.fn(async () => []) },
  };
  return { db: db as any, ligne, update };
}

describe('pushAppPlan', () => {
  it('signe `${ts}.${corps}` et envoie le payload v2 avec hub_user_id', async () => {
    const fetchImpl = reponse(200, { plan: 'pro', previous_plan: 'free' });
    const r = await pushAppPlan(
      { app: 'analytics', hubTenantId: 't-1', hubUserId: 'hub-1', plan: 'pro', planSource: 'grant_manual', reason: 'test' },
      { env, fetchImpl: fetchImpl as never, nowMs: () => 1_800_000_000_000 },
    );
    expect(r).toEqual({ ok: true, previousPlan: 'free' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://analytics.app.veridian.site/api/tenants/update-plan');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ contract_version: '2.0', tenant_id: 't-1', hub_user_id: 'hub-1', plan: 'pro', plan_source: 'grant_manual' });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    const h = init.headers as Record<string, string>;
    expect(h['X-Veridian-Timestamp']).toBe('1800000000000');
    expect(h['X-Veridian-Hub-Signature']).toBe(
      createHmac('sha256', 'secret-analytics').update(`1800000000000.${init.body}`).digest('hex'),
    );
  });

  it('crm : CRM_API_URL et CRM_HUB_API_SECRET', async () => {
    const fetchImpl = reponse(200, {});
    await pushAppPlan({ app: 'crm', hubTenantId: 't', hubUserId: 'h', plan: 'free', planSource: 'stripe' }, { env, fetchImpl: fetchImpl as never });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://crm.app.veridian.site/api/tenants/update-plan');
  });

  it('409 plan_source_immutable : plan offert côté app, immune', async () => {
    const r = await pushAppPlan(
      { app: 'analytics', hubTenantId: 't', hubUserId: 'h', plan: 'free', planSource: 'stripe' },
      { env, fetchImpl: reponse(409, { error: 'plan_source_immutable' }) as never },
    );
    expect(r).toEqual({ ok: true, immune: true });
  });

  it('non configuré : refus sans appel', async () => {
    const fetchImpl = vi.fn();
    const r = await pushAppPlan({ app: 'crm', hubTenantId: 't', hubUserId: 'h', plan: 'pro', planSource: 'stripe' }, { env: {} as never, fetchImpl });
    expect(r).toMatchObject({ ok: false, error: 'crm_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('setAppPlan', () => {
  it('envoie le statut d\'essai du tenant avec le plan', async () => {
    const { db } = fausseBase();
    const fetchImpl = reponse(200, {});
    await setAppPlan(db, { tenantId: 't-1', app: 'analytics', plan: 'pro', planSource: 'stripe_trial' }, { env, fetchImpl: fetchImpl as never });
    const corps = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(corps).toMatchObject({ trial_status: 'trial_active', trial_ends_at: '2026-12-01T00:00:00.000Z' });
  });

  it('accepté par l\'app : écrit metadata.<app>_plan sans perdre le reste', async () => {
    const { db, ligne } = fausseBase({ analytics: { linked_at: 'x' }, autre: 1 });
    const r = await setAppPlan(db, { tenantId: 't-1', app: 'analytics', plan: 'business', planSource: 'grant_manual', setBy: 'admin' }, { env, fetchImpl: reponse(200, {}) as never });
    expect(r.ok).toBe(true);
    expect(ligne.metadata).toMatchObject({ analytics: { linked_at: 'x' }, autre: 1, analytics_plan: 'business', analytics_plan_source: 'grant_manual', analytics_plan_set_by: 'admin' });
  });

  it.each([
    [404, { error: 'tenant_not_found' }],
    [400, { error: 'invalid_plan' }],
    [500, { error: 'Internal error' }],
  ])('refus de l\'app (%s) : rien n\'est écrit au Hub', async (status, corps) => {
    const { db, update } = fausseBase();
    const r = await setAppPlan(db, { tenantId: 't-1', app: 'analytics', plan: 'pro', planSource: 'grant_manual' }, { env, fetchImpl: reponse(status, corps) as never });
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('immune : rien n\'est écrit (le Hub n\'affiche pas un plan que l\'app refuse)', async () => {
    const { db, update } = fausseBase();
    await setAppPlan(db, { tenantId: 't-1', app: 'analytics', plan: 'free', planSource: 'stripe' }, { env, fetchImpl: reponse(409, { error: 'plan_source_immutable' }) as never });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('lecture et palier', () => {
  it('tenantHasApp : metadata de l\'app ou plan déjà posé', () => {
    expect(tenantHasApp({ analytics: {} }, 'analytics')).toBe(true);
    expect(tenantHasApp({ crm_plan: 'pro' }, 'crm')).toBe(true);
    expect(tenantHasApp({ analytics: {} }, 'crm')).toBe(false);
    expect(tenantHasApp(null, 'analytics')).toBe(false);
  });
  it('readAppPlan', () => {
    expect(readAppPlan({ crm_plan: 'pro', crm_plan_source: 'stripe' }, 'crm')).toEqual({ plan: 'pro', source: 'stripe' });
  });
  it('bundleTier : bundle actif → son palier, inactif → free, hors bundle → rien', () => {
    expect(bundleTier('veridian-pro', true)).toBe('pro');
    expect(bundleTier('veridian-business', true)).toBe('business');
    expect(bundleTier('internal', true)).toBe('enterprise');
    expect(bundleTier('veridian-business', false)).toBe('free');
    expect(bundleTier('notifuse-pro', true)).toBeNull();
    expect(bundleTier(null, true)).toBeNull();
  });
});
