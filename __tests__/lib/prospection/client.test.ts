import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  ProspectionClient,
  ProspectionError,
  readProspectionSecret,
  createProspectionClientFromEnv,
} from '@/lib/prospection/client';

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
