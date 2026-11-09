import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { lierAuHub } from '@/lib/apps/lier-hub';

const env = { ANALYTICS_API_URL: 'https://analytics.test', ANALYTICS_HUB_API_SECRET: 's3cret' } as NodeJS.ProcessEnv;
const ids = { hubUserId: 'u1', hubTenantId: 't1' };

describe('lierAuHub', () => {
  it('POST link-hub signé HMAC sur `${ts}.${corps}`, relie', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ linked: true, raison: 'relie' }), { status: 200 }));
    expect(await lierAuHub('analytics', ids, { env, fetchImpl: fetchImpl as never })).toEqual({ linked: true, raison: 'relie' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://analytics.test/api/tenants/link-hub');
    const h = init.headers as Record<string, string>;
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 's3cret').update(`${h['X-Veridian-Timestamp']}.${init.body}`).digest('hex'));
    expect(JSON.parse(String(init.body))).toEqual({ hub_user_id: 'u1', hub_tenant_id: 't1' });
  });
  it('409 lien_different : non relié, raison gardée', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'lien_different' }), { status: 409 }));
    expect(await lierAuHub('analytics', ids, { env, fetchImpl: fetchImpl as never })).toEqual({ linked: false, raison: 'lien_different' });
  });
  it('200 aucun_tenant : non relié', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ linked: false, raison: 'aucun_tenant' }), { status: 200 }));
    expect((await lierAuHub('analytics', ids, { env, fetchImpl: fetchImpl as never })).linked).toBe(false);
  });
});
