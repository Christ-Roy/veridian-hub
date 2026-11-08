import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { provisionCrmWorkspace } from '@/lib/crm/provision';

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
