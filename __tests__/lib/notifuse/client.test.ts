import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';

const SECRET = 'test-hub-secret';
const API_URL = 'https://notifuse.example.com';

function expectedSignature(timestamp: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('NotifuseClient HMAC requests', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('signs provisionWorkspace with HMAC + timestamp headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as string;
      const timestamp = (init!.headers as Record<string, string>)['X-Veridian-Timestamp'];
      const signature = (init!.headers as Record<string, string>)['X-Veridian-Hub-Signature'];

      expect(signature).toBe(expectedSignature(timestamp, body));
      return jsonResponse(200, {
        workspace_id: 'tenant_demo',
        owner_user_id: 'user_1',
        api_key: 'key',
        api_key_email: 'api@notifuse.local',
        magic_link: 'https://notifuse.example.com/console/magic?t=abc',
        plan: 'free',
        created: true,
      });
    });

    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    const res = await client.provisionWorkspace({
      tenantId: 'tenant_demo',
      ownerEmail: 'owner@example.com',
      plan: 'free',
    });

    expect(res.workspace_id).toBe('tenant_demo');
    expect(res.created).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API_URL}/api/tenants/provision`);
  });

  it('throws NotifuseError on 4xx without retry', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'tenant not found' }));
    const client = new NotifuseClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 2,
    });

    await expect(client.getStatus('missing')).rejects.toBeInstanceOf(NotifuseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'busy' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          tenant_id: 't',
          status: 'active',
          plan: 'free',
          monthly_email_quota: 1000,
          emails_sent_this_month: 0,
          quota_remaining: 1000,
        }),
      );

    const client = new NotifuseClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 2,
    });

    const status = await client.getStatus('t');
    expect(status.status).toBe('active');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws NotifuseError on persistent 5xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const client = new NotifuseClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 1,
    });

    await expect(client.suspendWorkspace({ tenantId: 't' })).rejects.toMatchObject({
      name: 'NotifuseError',
      code: 500,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('désigne la personne par hub_user_id (CONTRAT-HUB §5.19.7) au provisionnement', async () => {
    const corps: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => { corps.push(JSON.parse(String(init!.body))); return jsonResponse(200, { magic_link: 'https://notifuse.example.com/m' }); });
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    await client.provisionWorkspace({ tenantId: 't', ownerEmail: 'o@x.fr', hubUserId: 'h-1' });
    expect(corps).toEqual([expect.objectContaining({ owner_hub_user_id: 'h-1', metadata: { hub_user_id: 'h-1' } })]);
  });

  it('throws NotifuseError with code 0 on timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const client = new NotifuseClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 0,
      timeoutMs: 10,
    });

    await expect(client.deleteWorkspace('t')).rejects.toMatchObject({
      name: 'NotifuseError',
      code: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // attachOwner + getHealth — contrat v1 livré par l'agent Notifuse 2026-05-17
  // ---------------------------------------------------------------------------

  it('attachOwner POST /api/veridian/admin/attach-owner avec HMAC + body', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      const body = init?.body as string;
      const headers = init!.headers as Record<string, string>;
      expect(init?.method).toBe('POST');
      expect(headers['X-Veridian-Hub-Signature']).toBe(
        expectedSignature(headers['X-Veridian-Timestamp'], body),
      );
      const parsed = JSON.parse(body);
      expect(parsed).toEqual({
        tenant_id: 'robertbrunon',
        owner_email: 'robert.brunon@veridian.site',
        hub_user_id: '11111111-1111-4111-8111-111111111111',
        role: 'owner',
      });
      return jsonResponse(200, {
        tenant_id: 'robertbrunon',
        owner_email: 'robert.brunon@veridian.site',
        user_id: '0cb49456-12cc-43f2-9a4e-423d16fcfb44',
        attached: true,
        already_attached: false,
        owner_transferred: true,
        role: 'owner',
      });
    });

    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    const res = await client.attachOwner({
      tenantId: 'robertbrunon',
      ownerEmail: 'robert.brunon@veridian.site',
      hubUserId: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
    });

    expect(capturedUrl).toBe(`${API_URL}/api/veridian/admin/attach-owner`);
    expect(res.attached).toBe(true);
    expect(res.already_attached).toBe(false);
    expect(res.owner_transferred).toBe(true);
    expect(res.user_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lierTenantHub : le lien seul, sans plan ; conflit rendu ; route absente reconnue (26/11)', async () => {
    const rep = [jsonResponse(200, { changed: true }), jsonResponse(409, { error: 'hub_tenant_conflict' }), jsonResponse(404, {}), jsonResponse(404, { error: 'tenant_not_found' })];
    const corps: unknown[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => { corps.push(JSON.parse(init!.body as string)); return rep.shift()!; });
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await client.lierTenantHub('ws', 'T'));
    expect(r).toEqual([{ ok: true, changed: true }, { ok: false, code: 409, erreur: 'hub_tenant_conflict' }, { ok: false, absente: true, code: 404, erreur: 'route_absente' }, { ok: false, code: 404, erreur: 'tenant_not_found' }]);
    expect(corps[0]).toEqual({ tenant_id: 'ws', hub_tenant_id: 'T' });
  });

  it('attachOwner : un autre propriétaire humain, 409 rendu tel quel, jamais de transfert demandé ni rejoué (VER-263)', async () => {
    const corps: unknown[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => { corps.push(JSON.parse(init!.body as string)); return jsonResponse(409, { error: 'owner_exists' }); });
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.attachOwner({ tenantId: 'ws', ownerEmail: 'b@x.fr', hubUserId: '11111111-1111-4111-8111-111111111111', role: 'owner' })).rejects.toMatchObject({ code: 409 });
    expect(corps).toEqual([{ tenant_id: 'ws', owner_email: 'b@x.fr', hub_user_id: '11111111-1111-4111-8111-111111111111', role: 'owner' }]);
  });

  it('attachOwner désigne la personne par son hub_user_id et ne part jamais sans lui (VER-255)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.attachOwner({ tenantId: 'ws', ownerEmail: 'a@b.io', hubUserId: '' })).rejects.toThrow(/hubUserId/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attachOwner omet le champ role si non précisé (default Notifuse = owner)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(init!.body as string);
      expect(parsed).not.toHaveProperty('role');
      expect(parsed).toEqual({
        tenant_id: 'ws-1',
        owner_email: 'alice@test.io',
        hub_user_id: '11111111-1111-4111-8111-111111111111',
      });
      return jsonResponse(200, {
        tenant_id: 'ws-1',
        owner_email: 'alice@test.io',
        user_id: 'u-1',
        attached: true,
        already_attached: false,
        role: 'owner',
      });
    });
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    const res = await client.attachOwner({ tenantId: 'ws-1', ownerEmail: 'alice@test.io', hubUserId: '11111111-1111-4111-8111-111111111111' });
    expect(res.role).toBe('owner');
  });

  it('attachOwner: idempotence — already_attached:true when user déjà owner', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        tenant_id: 'ws-1',
        owner_email: 'alice@test.io',
        user_id: 'u-1',
        attached: false,
        already_attached: true,
        role: 'owner',
      }),
    );
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    const res = await client.attachOwner({ tenantId: 'ws-1', ownerEmail: 'alice@test.io', hubUserId: '11111111-1111-4111-8111-111111111111' });
    expect(res.attached).toBe(false);
    expect(res.already_attached).toBe(true);
  });

  it('attachOwner: throws NotifuseError sur 404 tenant inexistant', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'tenant not found' }));
    const client = new NotifuseClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 0,
    });
    await expect(
      client.attachOwner({ tenantId: 'missing', ownerEmail: 'a@b.io', hubUserId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject({ name: 'NotifuseError', code: 404 });
  });

  it('getHealth GET /api/tenants/{id}/health avec HMAC body vide', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      const headers = init!.headers as Record<string, string>;
      expect(init?.method).toBe('GET');
      // body vide pour GET → signature porte sur "{ts}." (rawBody = "")
      expect(headers['X-Veridian-Hub-Signature']).toBe(
        expectedSignature(headers['X-Veridian-Timestamp'], ''),
      );
      expect(init?.body).toBeUndefined();
      return jsonResponse(200, {
        tenant_id: 'robertbrunon',
        workspace_id: 'robertbrunon',
        status: 'active',
        owner_attached: true,
        owner_email: 'robert.brunon@veridian.site',
        owner_user_id: '0cb49456-12cc-43f2-9a4e-423d16fcfb44',
        api_key_valid: true,
        magic_link_capable: true,
        members_count: 2,
        plan: 'free',
        checked_at: '2026-05-18T07:30:00Z',
      });
    });

    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    const res = await client.getHealth('robertbrunon');

    expect(capturedUrl).toBe(`${API_URL}/api/tenants/robertbrunon/health`);
    expect(res.magic_link_capable).toBe(true);
    expect(res.owner_attached).toBe(true);
    expect(res.members_count).toBe(2);
  });

  it('getHealth encode-uri le tenant_id pour éviter injection path', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return jsonResponse(404, { error: 'tenant not found' });
    });
    const client = new NotifuseClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 0,
    });
    await expect(client.getHealth('weird/path with spaces')).rejects.toBeInstanceOf(NotifuseError);
    expect(capturedUrl).toBe(`${API_URL}/api/tenants/weird%2Fpath%20with%20spaces/health`);
  });

  it('getHealth: throws si tenantId vide (garde-fou)', async () => {
    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET });
    await expect(client.getHealth('')).rejects.toThrow(/tenantId is required/);
  });
});
