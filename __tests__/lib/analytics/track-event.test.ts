import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { trackGoal, resolveSiteId, resolveTrackBaseUrl, hubSessionId } from '@/lib/analytics/track-event';

const ENV_KEYS = ['DEPLOY_ENV', 'ANALYTICS_TRACK_URL', 'ANALYTICS_TRACK_URL_STAGING', 'ANALYTICS_TRACK_SITE_ID', 'ANALYTICS_TRACK_KEY'] as const;

/** Objectifs du Hub vers Rybbit (08/11 : ils partaient vers le moteur G2 arrêté, aucun n'arrivait). */
describe('lib/analytics/track-event', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  const ok = () => vi.fn(async () => new Response('{"success":true}', { status: 200 }));
  const silencieux = { warn: vi.fn() };

  describe('cible', () => {
    it('prod : Rybbit, site veridian.site (2)', () => {
      process.env.DEPLOY_ENV = 'prod';
      expect(resolveTrackBaseUrl()).toBe('https://analytics.app.veridian.site');
      expect(resolveSiteId()).toBe('2');
    });
    it('jamais l\'ancien moteur G2', () => {
      process.env.DEPLOY_ENV = 'prod';
      expect(resolveTrackBaseUrl()).not.toMatch(/analytics-engine/);
    });
    it('hors prod sans site explicite : aucun site, donc rien ne part', () => {
      process.env.DEPLOY_ENV = 'staging';
      expect(resolveSiteId()).toBeNull();
    });
    it('surcharges respectées, barre finale retirée', () => {
      process.env.DEPLOY_ENV = 'prod';
      process.env.ANALYTICS_TRACK_URL = 'https://autre.example/';
      process.env.ANALYTICS_TRACK_SITE_ID = '9';
      expect(resolveTrackBaseUrl()).toBe('https://autre.example');
      expect(resolveSiteId()).toBe('9');
    });
  });

  it('hubSessionId : préfixe hub-', () => {
    expect(hubSessionId('abc')).toBe('hub-abc');
  });

  describe('trackGoal : charge utile Rybbit', () => {
    it('custom_event sur le site, user_id = adresse normalisée, propriétés en JSON, en-têtes de navigateur', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const fetchImpl = ok();
      await trackGoal(
        { userEmail: '  Client@Exemple.FR ', goal: 'signup', sessionId: 'hub-u1', properties: { provider: 'google' } },
        { fetchImpl: fetchImpl as never, logger: silencieux },
      );
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://analytics.app.veridian.site/api/track');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        type: 'custom_event',
        site_id: '2',
        event_name: 'signup',
        user_id: 'client@exemple.fr',
        hostname: 'app.veridian.site',
        pathname: '/',
      });
      expect(JSON.parse(body.properties)).toEqual({ provider: 'google', session: 'hub-u1', source: 'hub' });
      expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^Mozilla\//);
    });

    it('hors prod sans site : aucun appel', async () => {
      process.env.DEPLOY_ENV = 'staging';
      const fetchImpl = ok();
      await trackGoal({ userEmail: 'a@b.c', goal: 'signup', sessionId: 's' }, { fetchImpl: fetchImpl as never, logger: silencieux });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('trackGoal : ingestion de confiance (sinon Rybbit classe le Hub, chez OVH, en robot)', () => {
    const req = (h: Record<string, string>) => ({ headers: new Headers(h) });
    it('avec la clé : Bearer, IP et navigateur du visiteur', async () => {
      process.env.DEPLOY_ENV = 'prod';
      process.env.ANALYTICS_TRACK_KEY = 'cle-ingest';
      const fetchImpl = ok();
      await trackGoal(
        { userEmail: 'a@b.c', goal: 'signup', sessionId: 's', request: req({ 'x-real-ip': '90.61.12.34', 'user-agent': 'Mozilla/5.0 Visiteur' }) },
        { fetchImpl: fetchImpl as never, logger: silencieux },
      );
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cle-ingest');
      expect(JSON.parse(String(init.body))).toMatchObject({ ip_address: '90.61.12.34', user_agent: 'Mozilla/5.0 Visiteur' });
    });
    it('IP invalide : écartée (Rybbit refuserait tout l\'événement)', async () => {
      process.env.DEPLOY_ENV = 'prod';
      process.env.ANALYTICS_TRACK_KEY = 'cle-ingest';
      const fetchImpl = ok();
      await trackGoal({ userEmail: 'a@b.c', goal: 'signup', sessionId: 's', request: req({}) }, { fetchImpl: fetchImpl as never, logger: silencieux });
      expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty('ip_address');
    });
    it('sans clé : ni Bearer ni IP transmise (Rybbit les ignorerait)', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const fetchImpl = ok();
      await trackGoal({ userEmail: 'a@b.c', goal: 'signup', sessionId: 's', request: req({ 'x-real-ip': '90.61.12.34' }) }, { fetchImpl: fetchImpl as never, logger: silencieux });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      expect(JSON.parse(String(init.body))).not.toHaveProperty('ip_address');
    });
  });

  describe('trackGoal : best-effort (ne lève jamais)', () => {
    it('adresse vide : rien, sans appel', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const fetchImpl = ok();
      const logger = { warn: vi.fn() };
      await trackGoal({ userEmail: '  ', goal: 'signup', sessionId: 's' }, { fetchImpl: fetchImpl as never, logger });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
    it('réseau en échec : résout, warn', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const logger = { warn: vi.fn() };
      const fetchImpl = vi.fn(async () => {
        throw new Error('ECONNRESET');
      });
      await expect(
        trackGoal({ userEmail: 'a@b.c', goal: 'signup', sessionId: 's' }, { fetchImpl: fetchImpl as never, logger }),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
    it('réponse non-2xx : résout, warn, pas de nouvel essai', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const logger = { warn: vi.fn() };
      const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 }));
      await trackGoal({ userEmail: 'a@b.c', goal: 'signup', sessionId: 's' }, { fetchImpl: fetchImpl as never, logger });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
