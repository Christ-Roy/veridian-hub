import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAcademyWorkspace } from '@/lib/academy/provision';
import { provisionAppWorkspace, ESPACE_APPS } from '@/lib/apps/espace-app';
import { isAppPlan, setAppPlan } from '@/lib/plans/app-plan';

const env = { ACADEMY_API_URL: 'https://academy.test/', ACADEMY_HUB_API_SECRET: 'acad-s3cret' } as NodeJS.ProcessEnv;
const input = { tenantId: 't-1', hubUserId: 'h-1', email: 'a@x.io', workspaceName: 'Robert' };

type Appel = [string, RequestInit];
const appels = (f: ReturnType<typeof vi.fn>) => f.mock.calls as unknown as Appel[];

describe('provisionAppWorkspace (academy)', () => {
  it('vise ACADEMY_API_URL, signe avec son propre secret et envoie hub_user_id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'aw-1', created: true }), { status: 200 }));
    const r = await provisionAppWorkspace(ESPACE_APPS.academy, input, { env, fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: () => 1000 });
    expect(r).toEqual({ ok: true, workspaceId: 'aw-1', created: true });
    const [url, init] = appels(fetchImpl)[0];
    expect(url).toBe('https://academy.test/api/tenants/provision');
    expect(JSON.parse(init.body as string)).toMatchObject({
      tenant_id: 't-1',
      owner_email: 'a@x.io',
      email_proven: true,
      metadata: { hub_user_id: 'h-1' },
    });
    const h = init.headers as Record<string, string>;
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 'acad-s3cret').update(`1000.${init.body}`).digest('hex'));
  });

  it('non configuré : academy_not_configured, aucun appel (le secret du CRM ne sert jamais)', async () => {
    const fetchImpl = vi.fn();
    const r = await provisionAppWorkspace(ESPACE_APPS.academy, input, {
      env: { CRM_API_URL: 'https://crm.test', CRM_HUB_API_SECRET: 'x' } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(r).toEqual({ ok: false, error: 'academy_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ensureAcademyWorkspace', () => {
  beforeEach(() => {
    process.env.ACADEMY_API_URL = 'https://academy.test';
    process.env.ACADEMY_HUB_API_SECRET = 'acad-s3cret';
  });

  const db = (tenant: { id: string; name: string; metadata: unknown } | null) => ({
    tenant: {
      findFirst: vi.fn(async () => tenant),
      findUnique: vi.fn(async () => (tenant ? { id: tenant.id, userId: 'h-1', metadata: tenant.metadata } : null)),
      update: vi.fn(async () => ({})),
    },
    tenantApp: { upsert: vi.fn(async () => ({})) },
    tenantTrial: { findMany: vi.fn(async () => []) },
    subscription: { findMany: vi.fn(async () => []) },
  });
  const app = () =>
    vi.fn(async (url: string) =>
      url.endsWith('/api/tenants/provision')
        ? new Response(JSON.stringify({ workspace_id: 'aw-9', created: true }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

  it('inscrit metadata.academy et active la clé academy (jamais twenty)', async () => {
    const d = db({ id: 't-1', name: 'Veridian', metadata: { garde: 1 } });
    const r = await ensureAcademyWorkspace(d as never, { hubUserId: 'h-1', email: 'R@X.io' }, { env, fetchImpl: app() as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, workspaceId: 'aw-9' });
    expect(d.tenant.update).toHaveBeenCalledWith({
      where: { id: 't-1' },
      data: { metadata: { garde: 1, academy: expect.objectContaining({ workspace_id: 'aw-9' }) } },
    });
    expect(d.tenantApp.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_appKey: { userId: 'h-1', appKey: 'academy' } } }),
    );
  });

  it('garde un plan academy déjà posé (internal), au lieu de le rabattre à free', async () => {
    const d = db({ id: 't-1', name: 'Veridian', metadata: { academy_plan: 'internal' } });
    const fetchImpl = app();
    await ensureAcademyWorkspace(d as never, { hubUserId: 'h-1', email: 'r@x.io' }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    const plan = appels(fetchImpl).find(([u]) => u.endsWith('/api/tenants/update-plan'));
    expect(plan, 'update-plan envoyé à Academy').toBeTruthy();
    expect(plan![0]).toBe('https://academy.test/api/tenants/update-plan');
    expect(JSON.parse(plan![1].body as string)).toMatchObject({ tenant_id: 't-1', plan: 'internal', plan_source: 'grant_manual' });
  });

  it('refus d\'Academy : rien n\'est inscrit au Hub, rien n\'est activé', async () => {
    const d = db({ id: 't-1', name: 'Veridian', metadata: null });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 502 }));
    const r = await ensureAcademyWorkspace(d as never, { hubUserId: 'h-1', email: 'a@x.io' }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(d.tenant.update).not.toHaveBeenCalled();
    expect(d.tenantApp.upsert).not.toHaveBeenCalled();
  });
});

describe('plans d\'Academy', () => {
  it('sa grille est la sienne : entreprise et lifetime_* oui, pro non', () => {
    for (const p of ['free', 'entreprise', 'internal', 'lifetime_partner', 'lifetime_site_vitrine']) {
      expect(isAppPlan('academy', p), p).toBe(true);
    }
    expect(isAppPlan('academy', 'pro')).toBe(false);
    expect(isAppPlan('crm', 'entreprise')).toBe(false);
  });

  it('setAppPlan refuse un plan hors grille sans rien envoyer à l\'app', async () => {
    const fetchImpl = vi.fn();
    const d = { tenant: { findUnique: vi.fn(), update: vi.fn() }, tenantTrial: {}, subscription: {} };
    const r = await setAppPlan(d as never, { tenantId: 't-1', app: 'academy', plan: 'pro', planSource: 'grant_manual' }, { env, fetchImpl });
    expect(r).toEqual({ ok: false, error: 'plan_invalid_for_academy', status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.tenant.update).not.toHaveBeenCalled();
  });
});
