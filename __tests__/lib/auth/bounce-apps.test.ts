/**
 * Tests unitaires de `lib/auth/bounce-apps.ts` — appel HMAC depuis Hub vers
 * `POST <app>/api/sso/issue-magic-link` (cf. CONTRAT-HUB §6bis.8.3).
 *
 * Couvre :
 *  - résolution config (ENV present / absent)
 *  - succès : 200 + magic_link_url → renvoie l'URL
 *  - 200 sans magic_link_url → BounceError invalid_response
 *  - 200 avec host non-veridian.site → invalid_response (anti compromise app)
 *  - 400 user_not_in_app → BounceError(user_not_in_app)
 *  - 400 autre → BounceError(unreachable)
 *  - 401/403 (HMAC mismatch) → unreachable
 *  - 404/405/501 (endpoint pas implémenté) → unreachable
 *  - 5xx → unreachable
 *  - timeout → unreachable
 *  - HMAC : timestamp + signature posés correctement
 *  - support de l'env custom + fetchImpl mocké
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import {
  issueMagicLinkForApp,
  resolveAppConfig,
  listSupportedApps,
  BounceError,
} from '@/lib/auth/bounce-apps';

const TEST_SECRET = 'hub-api-secret-test-32-bytes-xxxxxxx';
const TEST_URL = 'https://notifuse.veridian.site';

function makeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NOTIFUSE_API_URL: TEST_URL,
    NOTIFUSE_HUB_API_SECRET: TEST_SECRET,
    ...extra,
  };
}

describe('resolveAppConfig', () => {
  it('notifuse : URL + secret présents → config', () => {
    const c = resolveAppConfig('notifuse', makeEnv());
    expect(c).not.toBeNull();
    expect(c!.appName).toBe('notifuse');
    expect(c!.apiUrl).toBe(TEST_URL);
    expect(c!.hubSecret).toBe(TEST_SECRET);
  });

  it('trim trailing slash sur apiUrl', () => {
    const c = resolveAppConfig('notifuse', { ...makeEnv(), NOTIFUSE_API_URL: 'https://notifuse.veridian.site/' });
    expect(c!.apiUrl).toBe('https://notifuse.veridian.site');
  });

  it('URL absente → null', () => {
    const c = resolveAppConfig('notifuse', { NOTIFUSE_HUB_API_SECRET: TEST_SECRET });
    expect(c).toBeNull();
  });

  it('secret absent → null', () => {
    const c = resolveAppConfig('notifuse', { NOTIFUSE_API_URL: TEST_URL });
    expect(c).toBeNull();
  });

  it('app inconnue → null', () => {
    expect(resolveAppConfig('evil-app', makeEnv())).toBeNull();
    expect(resolveAppConfig('', makeEnv())).toBeNull();
  });

  it('prospection est mappé', () => {
    const c = resolveAppConfig('prospection', {
      PROSPECTION_API_URL: 'https://prospection.veridian.site',
      PROSPECTION_HUB_API_SECRET: 'sec',
    });
    expect(c).not.toBeNull();
    expect(c!.apiUrl).toBe('https://prospection.veridian.site');
  });

  it('cms est mappé', () => {
    const c = resolveAppConfig('cms', {
      CMS_API_URL: 'https://cms.veridian.site',
      CMS_HUB_API_SECRET: 'sec',
    });
    expect(c).not.toBeNull();
  });

  it('analytics est mappé', () => {
    const c = resolveAppConfig('analytics', {
      ANALYTICS_API_URL: 'https://analytics.veridian.site',
      ANALYTICS_HUB_API_SECRET: 'sec',
    });
    expect(c).not.toBeNull();
  });
});

describe('listSupportedApps', () => {
  it('renvoie la liste des 4 apps officielles', () => {
    const apps = listSupportedApps();
    expect(apps).toContain('notifuse');
    expect(apps).toContain('prospection');
    expect(apps).toContain('cms');
    expect(apps).toContain('analytics');
    expect(apps).toHaveLength(4);
  });
});

describe('issueMagicLinkForApp — succès', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 + magic_link_url valide → renvoie URL', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ magic_link_url: 'https://notifuse.app.veridian.site/auth/token?t=abc' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const r = await issueMagicLinkForApp(
      { app: 'notifuse', hubUserId: 'uuid-1', email: 'a@b.c' },
      { env: makeEnv(), fetchImpl: fetchMock as never },
    );
    expect(r.magicLinkUrl).toBe('https://notifuse.app.veridian.site/auth/token?t=abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_URL}/api/sso/issue-magic-link`);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('pose les headers HMAC corrects (timestamp + signature)', async () => {
    const FIXED_NOW = 1_700_000_000_000;
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site/auth/token?t=z' }),
        { status: 200 },
      ),
    );
    await issueMagicLinkForApp(
      { app: 'notifuse', hubUserId: 'uuid-1', email: 'a@b.c' },
      {
        env: makeEnv(),
        fetchImpl: fetchMock as never,
        nowMs: () => FIXED_NOW,
      },
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Veridian-Timestamp']).toBe(String(FIXED_NOW));
    expect(headers['Content-Type']).toBe('application/json');

    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ hub_user_id: 'uuid-1', email: 'a@b.c' });

    // Recompute la signature attendue
    const expectedSig = createHmac('sha256', TEST_SECRET)
      .update(`${FIXED_NOW}.${body}`)
      .digest('hex');
    expect(headers['X-Veridian-Hub-Signature']).toBe(expectedSig);
  });
});

describe('issueMagicLinkForApp — erreurs business', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ENV non configurée → BounceError(not_configured)', async () => {
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: {}, fetchImpl: vi.fn() as never },
      ),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('400 user_not_in_app → BounceError(user_not_in_app)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'user_not_in_app' }), { status: 400 }),
    );
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'user_not_in_app', httpStatus: 400 });
  });

  it('400 autre erreur → BounceError(unreachable)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad_input' }), { status: 400 }),
    );
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable', httpStatus: 400 });
  });

  it('401 (HMAC mismatch) → unreachable', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable', httpStatus: 401 });
  });

  it('403 (forbidden) → unreachable', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable', httpStatus: 403 });
  });

  it('404 (endpoint pas implémenté côté app) → unreachable', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable', httpStatus: 404 });
  });

  it('501 (not implemented) → unreachable', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 501 }));
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable', httpStatus: 501 });
  });

  it('500 → unreachable', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable', httpStatus: 500 });
  });

  it('502/503/504 → unreachable', async () => {
    for (const status of [502, 503, 504]) {
      const fetchMock = vi.fn(async () => new Response('', { status }));
      await expect(
        issueMagicLinkForApp(
          { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
          { env: makeEnv(), fetchImpl: fetchMock as never },
        ),
      ).rejects.toMatchObject({ code: 'unreachable', httpStatus: status });
    }
  });

  it('network throw → unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('200 sans magic_link_url → invalid_response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('200 magic_link_url avec host evil.com → invalid_response (anti-compromise app)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ magic_link_url: 'https://evil.com/x' }), { status: 200 }),
    );
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('200 magic_link_url avec faux suffixe veridian.site.attacker.com → invalid_response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site.attacker.com/x' }),
        { status: 200 },
      ),
    );
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('200 magic_link_url http (pas TLS) → invalid_response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ magic_link_url: 'http://notifuse.veridian.site/x' }), { status: 200 }),
    );
    await expect(
      issueMagicLinkForApp(
        { app: 'notifuse', hubUserId: 'u', email: 'a@b.c' },
        { env: makeEnv(), fetchImpl: fetchMock as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('BounceError', () => {
  it('porte code + httpStatus', () => {
    const e = new BounceError('user_not_in_app', 'no workspace', 400);
    expect(e.code).toBe('user_not_in_app');
    expect(e.httpStatus).toBe(400);
    expect(e.message).toBe('no workspace');
    expect(e.name).toBe('BounceError');
    expect(e).toBeInstanceOf(Error);
  });
});
