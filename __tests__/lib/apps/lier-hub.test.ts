import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { lierAuHub } from '@/lib/apps/lier-hub';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

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

describe('lierAuHub, version de signature', () => {
  const appeler = async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ linked: true, raison: 'relie' }), { status: 200 }));
    await lierAuHub('analytics', ids, { env, fetchImpl: fetchImpl as never });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init, h: init.headers as Record<string, string> };
  };
  it('HMAC_V2_APPS=analytics : l\'appel part en v2, lié à la méthode et au chemin', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'analytics');
    try {
      const { url, init, h } = await appeler();
      exigeV2(h, 's3cret', 'POST', url, String(init.body));
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('variable absente, ou nommant une autre app : v1', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    try {
      const { init, h } = await appeler();
      exigeV1(h, 's3cret', String(init.body));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
