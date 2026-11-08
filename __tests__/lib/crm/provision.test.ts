import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ensureCrmWorkspace, provisionCrmWorkspace } from '@/lib/crm/provision';

const env = { CRM_API_URL: 'https://crm.test/', CRM_HUB_API_SECRET: 's3cret' } as NodeJS.ProcessEnv;
const input = { tenantId: 't-1', hubUserId: 'h-1', email: 'a@x.io', workspaceName: 'Un nom bien plus long que trente-deux caractères' };

describe('provisionCrmWorkspace', () => {
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
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'ws-9', created: true }), { status: 200 }));
  const db = (tenant: unknown) => ({
    tenant: { findFirst: vi.fn(async () => tenant), update: vi.fn(async () => ({})) },
    tenantApp: { upsert: vi.fn(async () => ({})) },
  });

  it('sans tenant Hub : aucun appel au CRM', async () => {
    const d = db(null);
    const fetchImpl = vi.fn();
    const r = await ensureCrmWorkspace(d as never, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl });
    expect(r).toEqual({ ok: false, error: 'tenant_not_found', status: 404 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('inscrit metadata.crm (lu par reconcile) et active twenty', async () => {
    const d = db({ id: 't-1', name: 'ACME', metadata: { garde: 1 } });
    const r = await ensureCrmWorkspace(d as never, { hubUserId: 'h-1', email: 'A@X.io' }, { env, fetchImpl: ok() as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, workspaceId: 'ws-9' });
    expect(d.tenant.update).toHaveBeenCalledWith({
      where: { id: 't-1' },
      data: { metadata: { garde: 1, crm: expect.objectContaining({ workspace_id: 'ws-9' }) } },
    });
    expect(d.tenantApp.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_appKey: { userId: 'h-1', appKey: 'twenty' } } }),
    );
  });

  it('refus du CRM : rien n\'est inscrit au Hub', async () => {
    const d = db({ id: 't-1', name: 'ACME', metadata: null });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 502 }));
    const r = await ensureCrmWorkspace(d as never, { hubUserId: 'h-1', email: 'a@x.io' }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(d.tenant.update).not.toHaveBeenCalled();
    expect(d.tenantApp.upsert).not.toHaveBeenCalled();
  });
});
