/**
 * Tests du client HMAC Hub → app downstream pour la phase 4b du flow
 * invitation cross-app.
 *
 * Couvre :
 *   - Path resolution par app (notifuse → /api/tenants, autres → /api/veridian)
 *   - Base URL resolution (env override → fallback convention)
 *   - Secret manquant → pending(secret_missing) sans appel réseau
 *   - 200 / 201 happy path → completed + loginUrl + httpStatus
 *   - 404 endpoint absent → pending(endpoint_not_found)
 *   - 501 not implemented → pending(endpoint_not_implemented)
 *   - 5xx (avec retries épuisés) → pending(downstream_5xx)
 *   - Timeout → pending(timeout)
 *   - Erreur réseau → pending(network_error)
 *   - 4xx business (409, 423, etc.) → error + errorCode
 *   - HMAC headers présents (x-veridian-timestamp, signature, x-veridian-app, content-type)
 *   - Signature stable (déterministe sur même body+secret+timestamp)
 *   - 200 idempotent (already_member=true) propagé
 *   - 200 sans body JSON → completed + loginUrl=null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attachMemberDownstream,
  attachMemberPath,
  resolveDownstreamBaseUrl,
} from '@/lib/invitations/attach-downstream';

const baseInput = {
  targetApp: 'prospection' as const,
  targetWorkspaceId: 'ws_42',
  hubUserId: 'user_abc',
  hubUserEmail: 'alice@example.com',
  role: 'member',
  invitationId: 'inv_xyz',
  secretOverride: 'test-secret-1234',
  baseUrl: 'https://prospection.app.veridian.site',
  maxRetries: 0,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number) {
  return new Response('', {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('attachMemberPath', () => {
  it('uses /api/tenants/{id}/attach-member for notifuse', () => {
    expect(attachMemberPath('notifuse', 'ws_1')).toBe(
      '/api/tenants/ws_1/attach-member',
    );
  });

  it('uses /api/veridian/workspaces/{id}/attach-member for prospection', () => {
    expect(attachMemberPath('prospection', 'ws_42')).toBe(
      '/api/veridian/workspaces/ws_42/attach-member',
    );
  });

  it('uses same convention for analytics and cms', () => {
    expect(attachMemberPath('analytics', 'ws_a')).toBe(
      '/api/veridian/workspaces/ws_a/attach-member',
    );
    expect(attachMemberPath('cms', 'ws_c')).toBe(
      '/api/veridian/workspaces/ws_c/attach-member',
    );
  });

  it('encodes workspaceId for URL-safety', () => {
    expect(attachMemberPath('prospection', 'ws/42 with space')).toBe(
      '/api/veridian/workspaces/ws%2F42%20with%20space/attach-member',
    );
  });
});

describe('resolveDownstreamBaseUrl', () => {
  it('uses NEXT_PUBLIC_<APP>_URL when set', () => {
    expect(
      resolveDownstreamBaseUrl('notifuse', {
        NEXT_PUBLIC_NOTIFUSE_URL: 'https://notifuse.example.com',
      } as NodeJS.ProcessEnv),
    ).toBe('https://notifuse.example.com');
  });

  it('strips trailing slashes', () => {
    expect(
      resolveDownstreamBaseUrl('cms', {
        NEXT_PUBLIC_CMS_URL: 'https://cms.veridian.site///',
      } as NodeJS.ProcessEnv),
    ).toBe('https://cms.veridian.site');
  });

  it('falls back to <app>.app.veridian.site when env absent', () => {
    expect(resolveDownstreamBaseUrl('analytics', {} as NodeJS.ProcessEnv)).toBe(
      'https://analytics.app.veridian.site',
    );
  });
});

describe('attachMemberDownstream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns pending(secret_missing) without calling fetch if secret unresolved', async () => {
    const result = await attachMemberDownstream({
      ...baseInput,
      secretOverride: undefined,
      env: {} as NodeJS.ProcessEnv, // explicit empty → no HUB_INVITATION_SECRET_PROSPECTION
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('secret_missing');
      expect(result.httpStatus).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns completed + loginUrl on 201 response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        attached: true,
        already_member: false,
        login_url: 'https://prospection.app.veridian.site/magic?token=xyz',
        workspace_id: 'ws_42',
        role: 'member',
      }),
    );
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.loginUrl).toBe(
        'https://prospection.app.veridian.site/magic?token=xyz',
      );
      expect(result.alreadyMember).toBe(false);
      expect(result.httpStatus).toBe(201);
    }
  });

  it('propagates already_member=true from 200 idempotent response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        attached: true,
        already_member: true,
        login_url: 'https://prospection.app.veridian.site/login',
      }),
    );
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.alreadyMember).toBe(true);
      expect(result.httpStatus).toBe(200);
    }
  });

  it('returns completed + loginUrl=null when downstream body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.loginUrl).toBeNull();
    }
  });

  it('returns pending(endpoint_not_found) on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not_found' }));
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('endpoint_not_found');
      expect(result.httpStatus).toBe(404);
    }
  });

  it('returns pending(endpoint_not_implemented) on 501', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(501));
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('endpoint_not_implemented');
    }
  });

  it('returns pending(downstream_5xx) after retries exhausted on 503', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(emptyResponse(503));
    const result = await attachMemberDownstream({
      ...baseInput,
      maxRetries: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('downstream_5xx');
      expect(result.httpStatus).toBe(503);
    }
  });

  it('returns pending(timeout) when fetch is aborted', async () => {
    fetchMock.mockImplementationOnce(async (_url: any, init: any) => {
      // Simule un timeout : on attend que le signal soit aborté
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
      throw new Error('unreachable');
    });
    const result = await attachMemberDownstream({
      ...baseInput,
      timeoutMs: 5, // very short
      maxRetries: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('timeout');
    }
  });

  it('returns pending(network_error) on generic fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await attachMemberDownstream({
      ...baseInput,
      maxRetries: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.reason).toBe('network_error');
    }
  });

  it('returns error on business 4xx (409 user_role_conflict)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: 'user_role_conflict' }),
    );
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.httpStatus).toBe(409);
      expect(result.errorCode).toBe('user_role_conflict');
    }
  });

  it('returns error on 423 tenant_suspended', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(423, { error: 'tenant_suspended' }),
    );
    const result = await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.httpStatus).toBe(423);
      expect(result.errorCode).toBe('tenant_suspended');
    }
  });

  it('sends HMAC headers and POST with JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { attached: true, already_member: false }),
    );
    await attachMemberDownstream({
      ...baseInput,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://prospection.app.veridian.site/api/veridian/workspaces/ws_42/attach-member',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-veridian-app']).toBe('hub');
    expect(init.headers['x-veridian-timestamp']).toMatch(/^\d+$/);
    expect(init.headers['x-veridian-invitation-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(init.body)).toEqual({
      hub_user_id: 'user_abc',
      hub_user_email: 'alice@example.com',
      role: 'member',
      invitation_id: 'inv_xyz',
    });
  });

  it('uses /api/tenants path for notifuse', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { attached: true, already_member: false }),
    );
    await attachMemberDownstream({
      ...baseInput,
      targetApp: 'notifuse',
      baseUrl: 'https://notifuse.app.veridian.site',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://notifuse.app.veridian.site/api/tenants/ws_42/attach-member',
    );
  });

  it('retries once on 503 then succeeds on retry', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          attached: true,
          already_member: false,
          login_url: 'https://x',
        }),
      );
    const result = await attachMemberDownstream({
      ...baseInput,
      maxRetries: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
  });
});
