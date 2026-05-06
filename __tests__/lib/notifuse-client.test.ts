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

  it('uses Bearer auth (not HMAC) for generateMagicLink', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer tenant-api-key');
      expect(headers['X-Veridian-Hub-Signature']).toBeUndefined();
      expect(headers['X-Veridian-Timestamp']).toBeUndefined();
      return jsonResponse(200, {
        magic_link: 'https://notifuse.example.com/m?t=abc',
        expires_at: '2030-01-01T00:00:00Z',
      });
    });

    const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET, fetchImpl });
    const res = await client.generateMagicLink({
      apiKey: 'tenant-api-key',
      userEmail: 'owner@example.com',
    });

    expect(res.magic_link).toContain('https://');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
});
