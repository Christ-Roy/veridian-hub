import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureCrmWorkspace, provisionCrmWorkspace } from '@/lib/crm/provision';

const env = { CRM_API_URL: 'https://crm.test/', CRM_HUB_API_SECRET: 's3cret' } as NodeJS.ProcessEnv;
const input = { tenantId: 't-1', hubUserId: 'h-1', email: 'a@x.io', workspaceName: 'Un nom bien plus long que trente-deux caractères' };

describe('provisionCrmWorkspace', () => {
  it('compte d\'épreuve : le nom envoyé au CRM commence par e2e- (le sous-domaine en découle, jamais « veridian »)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'ws-1', created: true }), { status: 200 }));
    await provisionCrmWorkspace({ ...input, email: 'e2e-sso-moteur-1@veridian.site', workspaceName: 'Veridian' }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).workspace_name).toBe('e2e-Veridian');
  });
  it('signe `${ts}.${corps}` et envoie hub_user_id, sans mot de passe', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'ws-1', created: true }), { status: 200 }));
    const r = await provisionCrmWorkspace(input, { env, fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: () => 1000 });
    expect(r).toEqual({ ok: true, workspaceId: 'ws-1', created: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://crm.test/api/tenants/provision');
    const corps = JSON.parse(init.body as string);
    expect(corps).toMatchObject({ tenant_id: 't-1', owner_email: 'a@x.io', metadata: { hub_user_id: 'h-1' } });
    expect(corps.workspace_name.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(corps)).not.toMatch(/password/i);
    const h = init.headers as Record<string, string>;
    expect(h['X-Veridian-Timestamp']).toBe('1000');
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 's3cret').update(`1000.${init.body}`).digest('hex'));
  });

  it('non configuré : aucun appel', async () => {
    const fetchImpl = vi.fn();
    expect(await provisionCrmWorkspace(input, { env: {} as NodeJS.ProcessEnv, fetchImpl })).toEqual({ ok: false, error: 'crm_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refus du CRM : code et erreur remontés', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 }));
    expect(await provisionCrmWorkspace(input, { env, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: false, error: 'invalid_signature', status: 401 });
  });
});

describe('ensureCrmWorkspace', () => {
  beforeEach(() => {
    process.env.CRM_API_URL = 'https://crm.test';
    process.env.CRM_HUB_API_SECRET = 's3cret';
  });

  const ok = () => vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'ws-9', created: true }), { status: 200 }));
  const db = (tenant: { id: string; name: string; metadata: unknown } | null) => {
    const cree = { id: 't-neuf', name: 'a', metadata: null };
    return {
      tenant: {
        findFirst: vi.fn(async () => (tenant ? { id: tenant.id } : null)),
        findUnique: vi.fn(async ({ where }: { where: { id?: string; slug?: string } }) =>
          where.slug ? null : where.id === tenant?.id ? tenant : where.id === cree.id ? cree : null,
        ),
        create: vi.fn(async () => ({ id: cree.id })),
        update: vi.fn(async () => ({})),
      },
      // La fusion par la base (lib/tenants/metadata-fusion.ts).
      $executeRaw: vi.fn(async () => 1),
      tenantApp: { upsert: vi.fn(async () => ({})) },
    };
  };

  it('sans tenant Hub (client « CRM seul ») : le tenant est créé, puis l\'espace', async () => {
    const d = db(null);
    const r = await ensureCrmWorkspace(d as never, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl: ok() as unknown as typeof fetch });
    expect(d.tenant.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'h', status: 'active' }) }));
    expect(r).toMatchObject({ ok: true, workspaceId: 'ws-9' });
    expect((d.$executeRaw.mock.calls[0] as unknown as [{ values: unknown[] }])[0].values[1]).toBe('t-neuf');
  });

  it('inscrit metadata.crm (lu par reconcile) et active twenty', async () => {
    const d = db({ id: 't-1', name: 'ACME', metadata: { garde: 1 } });
    const r = await ensureCrmWorkspace(d as never, { hubUserId: 'h-1', email: 'A@X.io' }, { env, fetchImpl: ok() as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, workspaceId: 'ws-9' });
    const [q] = d.$executeRaw.mock.calls[0] as unknown as [{ values: unknown[] }];
    expect([JSON.parse(String(q.values[0])), q.values[1]]).toEqual([{ crm: expect.objectContaining({ workspace_id: 'ws-9' }) }, 't-1']);
    expect(d.tenantApp.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_appKey: { userId: 'h-1', appKey: 'twenty' } } }),
    );
  });

  it('refus du CRM : rien n\'est inscrit au Hub', async () => {
    const d = db({ id: 't-1', name: 'ACME', metadata: null });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 502 }));
    const r = await ensureCrmWorkspace(d as never, { hubUserId: 'h-1', email: 'a@x.io' }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(d.$executeRaw).not.toHaveBeenCalled();
    expect(d.tenantApp.upsert).not.toHaveBeenCalled();
  });
  it('pousse le nom du Hub au CRM, qui nommait le compte d\'après l\'adresse', async () => {
    const d = db({ id: 't-1', name: 'ACME', metadata: null });
    const fetchImpl = ok();
    await ensureCrmWorkspace(d as never, { hubUserId: 'h-1', email: 'a@x.io', name: 'Alice Martin' }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    const sync = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(([u]) => u.endsWith('/api/hub/users/sync'));
    expect(sync, 'appel /api/hub/users/sync').toBeTruthy();
    expect(JSON.parse(sync![1].body as string)).toMatchObject({ hub_user_id: 'h-1', name: 'Alice Martin' });
  });
});

describe('base injectée (26/11)', () => {
  it('sans $executeRaw, l\'espace CRM ne s\'inscrit pas en réécrivant metadata : l\'ouverture échoue franchement', async () => {
    const update = vi.fn(async () => ({}));
    const d = { tenant: { findFirst: vi.fn(async () => ({ id: 't-1', name: 'A', metadata: {} })), findUnique: vi.fn(async () => ({ id: 't-1', userId: 'h', metadata: {} })), update }, tenantApp: { upsert: vi.fn() }, tenantTrial: { findMany: vi.fn(async () => []) }, subscription: { findMany: vi.fn(async () => []) } };
    const f = vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'ws-9', created: true }), { status: 200 }));
    await expect(ensureCrmWorkspace(d as never, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow();
    expect(update.mock.calls.some((c) => JSON.stringify(c).includes('metadata'))).toBe(false);
  });
});
