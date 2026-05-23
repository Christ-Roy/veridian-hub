/**
 * Tests unitaires de `lib/sync/discovery.ts` (Niveau 1 du tenant sync).
 *
 * Couvre :
 *   - Cas heureux : 200 + workspaces → snapshots typed
 *   - 404 → { found: false }
 *   - 5xx / timeout → { error } sans throw
 *   - App non configurée (ENV manquant) → { error: 'app_not_configured' }
 *   - Discovery cross-app : Promise.allSettled, partial failures
 *   - HMAC headers présents (timestamp + signature)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  discoverAppForEmail,
  discoverUserApps,
} from '@/lib/sync/discovery';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.useRealTimers();
  // Reset toutes les ENV sync à des valeurs connues pour les tests.
  process.env.NOTIFUSE_API_URL = 'https://notifuse.test';
  process.env.NOTIFUSE_HUB_API_SECRET = 'notifuse-secret-test';
  process.env.PROSPECTION_API_URL = 'https://prospection.test';
  process.env.PROSPECTION_HUB_API_SECRET = 'prospection-secret-test';
  delete process.env.ANALYTICS_API_URL;
  delete process.env.ANALYTICS_HUB_API_SECRET;
  delete process.env.CMS_API_URL;
  delete process.env.CMS_HUB_API_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discoverAppForEmail', () => {
  it('parses workspaces into typed snapshots on 200', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResp(200, {
        found: true,
        workspaces: [
          {
            workspace_id: 'ws-1',
            workspace_name: 'AVSE',
            role: 'owner',
            plan: 'pro',
            status: 'active',
            magic_link_capable: true,
            fallback_url: 'https://notifuse.test/console',
          },
        ],
      }),
    );

    const result = await discoverAppForEmail('notifuse', 'user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      found: true,
      snapshots: [
        expect.objectContaining({
          app: 'notifuse',
          workspaceId: 'ws-1',
          workspaceName: 'AVSE',
          role: 'owner',
          plan: 'pro',
          status: 'active',
          magicLinkCapable: true,
          fallbackUrl: 'https://notifuse.test/console',
        }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns { found: false } on 404', async () => {
    const fetchMock = vi.fn(async () => jsonResp(404, { found: false }));
    const result = await discoverAppForEmail('notifuse', 'unknown@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ found: false });
  });

  it('returns { found: false } if body.found=false even with 200', async () => {
    const fetchMock = vi.fn(async () => jsonResp(200, { found: false }));
    const result = await discoverAppForEmail('notifuse', 'unknown@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ found: false });
  });

  it('returns { error, httpStatus } on 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResp(503, { error: 'down' }));
    const result = await discoverAppForEmail('notifuse', 'user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ error: 'http_503', httpStatus: 503 });
  });

  it('returns { error: app_not_configured } when ENV missing', async () => {
    const result = await discoverAppForEmail('cms', 'user@x.com');
    expect(result).toMatchObject({
      error: expect.stringContaining('app_not_configured'),
    });
  });

  it('returns { error: timeout_XXXms } when fetch is aborted', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit | undefined): Promise<Response> => {
        // Simule un timeout : on attend que le signal soit aborted.
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    );
    const result = await discoverAppForEmail('notifuse', 'user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ error: expect.stringContaining('timeout_') });
  });

  it('attaches HMAC headers (timestamp + signature) on request', async () => {
    let capturedHeaders: Headers | undefined;
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit | undefined): Promise<Response> => {
        capturedHeaders = new Headers(init?.headers);
        return jsonResp(404, { found: false });
      },
    );

    await discoverAppForEmail('notifuse', 'user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(capturedHeaders?.get('X-Veridian-Timestamp')).toMatch(/^\d+$/);
    const sig = capturedHeaders?.get('X-Veridian-Hub-Signature');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);

    // Vérif HMAC : on recalcule avec le secret connu en test.
    const ts = capturedHeaders?.get('X-Veridian-Timestamp');
    const expected = createHmac('sha256', 'notifuse-secret-test')
      .update(`${ts}.`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('encodes email in querystring (special chars)', async () => {
    let capturedUrl = '';
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      capturedUrl = url;
      return jsonResp(404, { found: false });
    });
    await discoverAppForEmail('notifuse', 'user+test@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(capturedUrl).toContain('email=user%2Btest%40x.com');
  });

  it('falls back on legacy secret for prospection', async () => {
    delete process.env.PROSPECTION_HUB_API_SECRET;
    process.env.PROSPECTION_TENANT_API_SECRET = 'legacy-prospection';
    let capturedHeaders: Headers | undefined;
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit | undefined): Promise<Response> => {
        capturedHeaders = new Headers(init?.headers);
        return jsonResp(404, { found: false });
      },
    );
    await discoverAppForEmail('prospection', 'user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const ts = capturedHeaders?.get('X-Veridian-Timestamp');
    const expected = createHmac('sha256', 'legacy-prospection')
      .update(`${ts}.`)
      .digest('hex');
    expect(capturedHeaders?.get('X-Veridian-Hub-Signature')).toBe(expected);
  });
});

describe('discoverUserApps (cross-app aggregator)', () => {
  it('returns result for all 4 apps, with not-configured apps as error', async () => {
    const fetchMock = vi.fn(async () => jsonResp(404, { found: false }));
    const result = await discoverUserApps('user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(Object.keys(result.apps).sort()).toEqual([
      'analytics',
      'cms',
      'notifuse',
      'prospection',
    ]);
    expect(result.apps.notifuse).toEqual({ found: false });
    expect(result.apps.prospection).toEqual({ found: false });
    expect(result.apps.cms).toMatchObject({
      error: expect.stringContaining('app_not_configured'),
    });
    expect(result.apps.analytics).toMatchObject({
      error: expect.stringContaining('app_not_configured'),
    });
    expect(result.email).toBe('user@x.com');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('isolates failures — one app throws does not break the others', async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (url.includes('notifuse.test')) {
        throw new Error('boom notifuse');
      }
      return jsonResp(200, {
        found: true,
        workspaces: [{ workspace_id: 'ws-prosp', plan: 'pro' }],
      });
    });

    const result = await discoverUserApps('user@x.com', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      apps: ['notifuse', 'prospection'],
    });
    expect(result.apps.notifuse).toMatchObject({ error: 'boom notifuse' });
    expect(result.apps.prospection).toMatchObject({
      found: true,
      snapshots: expect.arrayContaining([
        expect.objectContaining({ app: 'prospection', workspaceId: 'ws-prosp' }),
      ]),
    });
  });
});
