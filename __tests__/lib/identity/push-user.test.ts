import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushUserToApps } from '@/lib/identity/push-user';

const respond = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('pushUserToApps', () => {
  beforeEach(() => {
    vi.stubEnv('NOTIFUSE_API_URL', 'https://n.test');
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 'secret');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('signe le corps et n\'envoie que les champs demandés', async () => {
    const fetchImpl = vi.fn(async () => respond(200));
    await pushUserToApps(
      { hubUserId: 'u1', name: 'Nom' },
      { apps: ['notifuse'], fetchImpl: fetchImpl as never },
    );
    const [url, init] = fetchImpl.mock.calls[0] as never as [string, RequestInit];
    expect(url).toBe('https://n.test/api/hub/users/sync');
    expect(JSON.parse(init.body as string)).toEqual({ hub_user_id: 'u1', name: 'Nom' });
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Veridian-Hub-Signature']).toBe(
      createHmac('sha256', 'secret')
        .update(`${headers['X-Veridian-Timestamp']}.${init.body}`)
        .digest('hex'),
    );
  });

  it.each([
    [200, {}, 'ok'],
    [404, { error: 'user_not_in_app' }, 'not_in_app'],
    [404, {}, 'endpoint_missing'],
    [500, {}, 'failed'],
    [401, {}, 'failed'],
  ])('HTTP %i %j → %s', async (status, body, expected) => {
    const fetchImpl = vi.fn(async () => respond(status, body));
    const r = await pushUserToApps({ hubUserId: 'u1' }, { apps: ['notifuse'], fetchImpl: fetchImpl as never });
    expect(r.notifuse).toBe(expected);
  });

  it('une panne réseau ne lève jamais, et une app non câblée le dit', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const r = await pushUserToApps(
      { hubUserId: 'u1' },
      { apps: ['notifuse', 'analytics'], fetchImpl: fetchImpl as never },
    );
    expect(r).toEqual({ notifuse: 'failed', analytics: 'not_configured' });
  });
});
