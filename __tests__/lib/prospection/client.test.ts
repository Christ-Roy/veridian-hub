import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProspectionClient,
  ProspectionError,
  readProspectionSecret,
  createProspectionClientFromEnv,
} from '@/lib/prospection/client';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

const SECRET = 'test-hub-secret';
const API_URL = 'https://prospection.example.com';

function expectedSignature(timestamp: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ProspectionClient HMAC requests', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('signe provisionTenant avec HMAC standard {ts}.{body}', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as string;
      const timestamp = (init!.headers as Record<string, string>)[
        'X-Veridian-Timestamp'
      ];
      const signature = (init!.headers as Record<string, string>)[
        'X-Veridian-Hub-Signature'
      ];

      expect(signature).toBe(expectedSignature(timestamp, body));
      // Pas de Bearer legacy
      expect(
        (init!.headers as Record<string, string>).Authorization,
      ).toBeUndefined();

      return jsonResponse(200, {
        tenant_id: 't-1',
        api_key: 'key-1',
        login_url: 'https://prospection.example.com/login?t=tok',
        created: true,
      });
    });

    const client = new ProspectionClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
    });
    const res = await client.provisionTenant({
      email: 'alice@veridian.test',
      name: 'alice',
      userId: 'uuid-alice',
      plan: 'freemium',
    });

    expect(res.tenant_id).toBe('t-1');
    expect(res.created).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API_URL}/api/tenants/provision`,
    );

    const sentBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.user_id).toBe('uuid-alice');
    expect(sentBody.metadata).toEqual({ hub_user_id: 'uuid-alice' });
    expect(sentBody.plan).toBe('freemium');
    await client.provisionTenant({ email: 'b@veridian.test', name: 'b', userId: 'uuid-b' });
    expect('plan' in JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string), 'sans plan : rien d\'envoyé').toBe(false);
  });

  it('throw ProspectionError sur 4xx sans retry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: 'invalid signature' }),
    );
    const client = new ProspectionClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 2,
    });

    await expect(
      client.provisionTenant({
        email: 'a@b.c',
        name: 'a',
        userId: 'u',
      }),
    ).rejects.toBeInstanceOf(ProspectionError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retry sur 5xx jusquà maxRetries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          tenant_id: 't-ok',
          api_key: 'k',
          login_url: 'https://x/?t=y',
        }),
      );

    const client = new ProspectionClient({
      apiUrl: API_URL,
      hubSecret: SECRET,
      fetchImpl,
      maxRetries: 2,
    });

    const res = await client.provisionTenant({
      email: 'a@b.c',
      name: 'a',
      userId: 'u',
    });
    expect(res.tenant_id).toBe('t-ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('readProspectionSecret / createProspectionClientFromEnv', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PROSPECTION_HUB_API_SECRET;
    delete process.env.PROSPECTION_TENANT_API_SECRET;
    delete process.env.PROSPECTION_API_URL;
  });

  it('PROSPECTION_HUB_API_SECRET prend la priorité sur le legacy', () => {
    process.env.PROSPECTION_HUB_API_SECRET = 'new';
    process.env.PROSPECTION_TENANT_API_SECRET = 'legacy';
    expect(readProspectionSecret()).toBe('new');
  });

  it('fallback sur PROSPECTION_TENANT_API_SECRET si HUB absent', () => {
    process.env.PROSPECTION_TENANT_API_SECRET = 'legacy';
    expect(readProspectionSecret()).toBe('legacy');
  });

  it('createProspectionClientFromEnv retourne null si URL absente', () => {
    process.env.PROSPECTION_HUB_API_SECRET = 'x';
    expect(createProspectionClientFromEnv()).toBeNull();
  });

  it('createProspectionClientFromEnv retourne null si secret absent', () => {
    process.env.PROSPECTION_API_URL = 'https://x.test';
    expect(createProspectionClientFromEnv()).toBeNull();
  });

  it('createProspectionClientFromEnv instancie le client si tout est là', () => {
    process.env.PROSPECTION_API_URL = 'https://x.test';
    process.env.PROSPECTION_HUB_API_SECRET = 'secret';
    const client = createProspectionClientFromEnv();
    expect(client).toBeInstanceOf(ProspectionClient);
  });
});

describe('ProspectionClient, version de signature', () => {
  const appeler = async (maxRetries: number, premier: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const vus: { url: string; method: string; h: Record<string, string>; corps: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      vus.push({ url, method: String(init?.method), h: init!.headers as Record<string, string>, corps: String(init?.body ?? '') });
      vi.setSystemTime(Date.now() + 7);
      return jsonResponse(vus.length === 1 ? premier : 200, { ok: true });
    });
    const client = new ProspectionClient({ apiUrl: 'https://prospection.example.com', hubSecret: 'test-hub-secret', fetchImpl, maxRetries });
    await client.softDeleteTenant('x@y.fr', { purgeEligibleAt: '2027-01-01T00:00:00Z' }).catch(() => undefined);
    return vus;
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it('HMAC_V2_APPS=prospection : l\'appel part en v2, lié à sa méthode et à son chemin', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'prospection');
    const [v] = await appeler(0, 200);
    exigeV2(v.h, 'test-hub-secret', v.method, v.url, v.corps);
  });
  it('variable absente, ou nommant une autre app : v1', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'crm');
    const [v] = await appeler(0, 200);
    exigeV1(v.h, 'test-hub-secret', v.corps);
  });
  it('v2 : chaque nouvel essai après un 503 prend un timestamp et une signature neufs', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'prospection');
    const [a, b] = await appeler(2, 503);
    expect(b).toBeDefined();
    expect(a.h['X-Veridian-Timestamp']).not.toBe(b.h['X-Veridian-Timestamp']);
    expect(a.h['X-Veridian-Hub-Signature']).not.toBe(b.h['X-Veridian-Hub-Signature']);
    exigeV2(b.h, 'test-hub-secret', b.method, b.url, b.corps);
  });
});
