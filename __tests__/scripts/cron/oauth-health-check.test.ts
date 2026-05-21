/**
 * Tests pour scripts/cron/oauth-health-check.ts
 *
 * Couvre :
 *  - Google discovery OK / KO / mauvais issuer
 *  - Microsoft secret check OK (>WARN_DAYS), KO (<WARN_DAYS), tous expirés
 *  - Skip propre si credentials Microsoft absents
 *  - Envoi Telegram quand failed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  fetchMock.mockReset();
  // Reset env relatif au cron
  delete process.env.MICROSOFT_OAUTH_TENANT_ID;
  delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
  delete process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
  delete process.env.MICROSOFT_OAUTH_OBJECT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.OAUTH_HEALTH_WARN_DAYS = '90';
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('checkGoogleDiscovery', () => {
  it('renvoie ok=true quand issuer correct', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ issuer: 'https://accounts.google.com' }),
    });
    const { checkGoogleDiscovery } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkGoogleDiscovery();
    expect(r.ok).toBe(true);
    expect(r.check).toBe('google-discovery');
  });

  it('renvoie ok=false sur HTTP non-200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const { checkGoogleDiscovery } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkGoogleDiscovery();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('503');
  });

  it('renvoie ok=false si issuer inattendu (provider hijack ?)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ issuer: 'https://attacker.example.com' }),
    });
    const { checkGoogleDiscovery } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkGoogleDiscovery();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Issuer inattendu');
  });

  it('renvoie ok=false si fetch throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { checkGoogleDiscovery } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkGoogleDiscovery();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('network down');
  });
});

describe('checkMicrosoftSecretExpiry', () => {
  it('skip si credentials Microsoft absents', async () => {
    const { checkMicrosoftSecretExpiry } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkMicrosoftSecretExpiry();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('skip');
  });

  it('ok=false si OBJECT_ID manquant alors que creds présents', async () => {
    process.env.MICROSOFT_OAUTH_TENANT_ID = 't';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'c';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 's';
    // pas de OBJECT_ID
    const { checkMicrosoftSecretExpiry } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkMicrosoftSecretExpiry();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('OBJECT_ID');
  });

  it('ok=true quand secret expire bien après le seuil', async () => {
    process.env.MICROSOFT_OAUTH_TENANT_ID = 't';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'c';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 's';
    process.env.MICROSOFT_OAUTH_OBJECT_ID = 'obj-1';

    // 1er fetch = token, 2e fetch = graph
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          passwordCredentials: [
            {
              displayName: 'Veridian Hub Prod 2026',
              keyId: 'k1',
              endDateTime: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
            },
          ],
        }),
      });

    const { checkMicrosoftSecretExpiry } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkMicrosoftSecretExpiry();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/valide \d+j/);
  });

  it('ok=false quand secret expire dans <90j', async () => {
    process.env.MICROSOFT_OAUTH_TENANT_ID = 't';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'c';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 's';
    process.env.MICROSOFT_OAUTH_OBJECT_ID = 'obj-1';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          passwordCredentials: [
            {
              displayName: 'expiring-soon',
              keyId: 'k1',
              endDateTime: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
            },
          ],
        }),
      });

    const { checkMicrosoftSecretExpiry } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkMicrosoftSecretExpiry();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('expire dans');
  });

  it('ok=false si tous les secrets sont expirés', async () => {
    process.env.MICROSOFT_OAUTH_TENANT_ID = 't';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'c';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 's';
    process.env.MICROSOFT_OAUTH_OBJECT_ID = 'obj-1';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          passwordCredentials: [
            {
              displayName: 'old',
              keyId: 'k0',
              endDateTime: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
            },
          ],
        }),
      });

    const { checkMicrosoftSecretExpiry } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkMicrosoftSecretExpiry();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('expirés');
  });

  it('ok=false sur erreur Graph', async () => {
    process.env.MICROSOFT_OAUTH_TENANT_ID = 't';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'c';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 's';
    process.env.MICROSOFT_OAUTH_OBJECT_ID = 'obj-1';

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
      });

    const { checkMicrosoftSecretExpiry } = await import('../../../scripts/cron/oauth-health-check');
    const r = await checkMicrosoftSecretExpiry();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('403');
  });
});

describe('sendTelegramAlert', () => {
  it('no-op silencieux quand TELEGRAM_BOT_TOKEN absent', async () => {
    const { sendTelegramAlert } = await import('../../../scripts/cron/oauth-health-check');
    await sendTelegramAlert('hi');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appelle l\'API Telegram quand configuré', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '42';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const { sendTelegramAlert } = await import('../../../scripts/cron/oauth-health-check');
    await sendTelegramAlert('alert!');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('api.telegram.org/bottok/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('42');
    expect(body.text).toBe('alert!');
  });

  it('ne throw pas si fetch Telegram échoue', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '42';
    fetchMock.mockRejectedValueOnce(new Error('network'));

    const { sendTelegramAlert } = await import('../../../scripts/cron/oauth-health-check');
    await expect(sendTelegramAlert('alert!')).resolves.toBeUndefined();
  });
});

describe('runHealthChecks', () => {
  it('exécute Google + Microsoft en parallèle', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ issuer: 'https://accounts.google.com' }),
    });

    const { runHealthChecks } = await import('../../../scripts/cron/oauth-health-check');
    const results = await runHealthChecks();

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.check).sort()).toEqual([
      'google-discovery',
      'microsoft-secret-expiry',
    ]);
  });
});
