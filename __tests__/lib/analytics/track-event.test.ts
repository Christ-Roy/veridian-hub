import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  trackGoal,
  resolveWorkspaceId,
  resolveTrackBaseUrl,
  hubSessionId,
} from '@/lib/analytics/track-event';

const ENV_KEYS = [
  'DEPLOY_ENV',
  'ANALYTICS_TRACK_URL',
  'ANALYTICS_TRACK_URL_STAGING',
] as const;

describe('lib/analytics/track-event', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  describe('resolveWorkspaceId', () => {
    it('prod → vrd_veridian_site_prod', () => {
      process.env.DEPLOY_ENV = 'prod';
      expect(resolveWorkspaceId()).toBe('vrd_veridian_site_prod');
    });

    it('staging → vrd_veridian_site_staging', () => {
      process.env.DEPLOY_ENV = 'staging';
      expect(resolveWorkspaceId()).toBe('vrd_veridian_site_staging');
    });

    it('local (non-prod) → staging workspace (jamais de pollution du prod)', () => {
      process.env.DEPLOY_ENV = 'local';
      expect(resolveWorkspaceId()).toBe('vrd_veridian_site_staging');
    });
  });

  describe('resolveTrackBaseUrl', () => {
    it('prod fallback = engine prod public', () => {
      process.env.DEPLOY_ENV = 'prod';
      delete process.env.ANALYTICS_TRACK_URL;
      expect(resolveTrackBaseUrl()).toBe(
        'https://analytics-engine.app.veridian.site',
      );
    });

    it('staging fallback = engine staging public', () => {
      process.env.DEPLOY_ENV = 'staging';
      delete process.env.ANALYTICS_TRACK_URL_STAGING;
      delete process.env.ANALYTICS_TRACK_URL;
      expect(resolveTrackBaseUrl()).toBe(
        'https://analytics-engine.staging.veridian.site',
      );
    });

    it('override ENV prod respecté + trailing slash strippé', () => {
      process.env.DEPLOY_ENV = 'prod';
      process.env.ANALYTICS_TRACK_URL = 'https://custom.example.com/';
      expect(resolveTrackBaseUrl()).toBe('https://custom.example.com');
    });

    it('override staging dédié prioritaire sur le générique', () => {
      process.env.DEPLOY_ENV = 'staging';
      process.env.ANALYTICS_TRACK_URL = 'https://generic.example.com';
      process.env.ANALYTICS_TRACK_URL_STAGING = 'https://staging.example.com';
      expect(resolveTrackBaseUrl()).toBe('https://staging.example.com');
    });
  });

  describe('hubSessionId', () => {
    it('préfixe hub- sur le uuid', () => {
      expect(hubSessionId('abc-123')).toBe('hub-abc-123');
    });
  });

  describe('trackGoal — payload', () => {
    it('émet un POST /api/track bien formé (epoch ms, goal, user_id=email normalisé)', async () => {
      process.env.DEPLOY_ENV = 'prod';
      delete process.env.ANALYTICS_TRACK_URL;
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));
      const fixedNow = 1_781_000_000_000;

      await trackGoal(
        {
          userEmail: '  Test@Veridian.SITE ',
          goal: 'signup',
          sessionId: 'hub-uuid-1',
          properties: { provider: 'credentials' },
        },
        { fetchImpl, now: () => fixedNow },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://analytics-engine.app.veridian.site/api/track');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(init.body);
      expect(sent.workspace_id).toBe('vrd_veridian_site_prod');
      expect(sent.session_id).toBe('hub-uuid-1');
      expect(sent.user_id).toBe('test@veridian.site');
      expect(sent.created_at).toBe(fixedNow);
      expect(sent.updated_at).toBe(fixedNow);
      expect(sent.actions).toHaveLength(1);
      const action = sent.actions[0];
      expect(action.type).toBe('goal');
      expect(action.name).toBe('signup');
      expect(action.timestamp).toBe(fixedNow);
      expect(action.path).toBe('/');
      expect(action.page_number).toBe(1);
      expect(action.properties).toEqual({ provider: 'credentials' });
    });

    it('omet properties si non fournies', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));
      await trackGoal(
        { userEmail: 'a@b.com', goal: 'app_started', sessionId: 's' },
        { fetchImpl },
      );
      const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(sent.actions[0].properties).toBeUndefined();
    });

    it('respecte un path custom', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));
      await trackGoal(
        { userEmail: 'a@b.com', goal: 'x', sessionId: 's', path: '/dashboard' },
        { fetchImpl },
      );
      const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(sent.actions[0].path).toBe('/dashboard');
    });
  });

  describe('trackGoal — best-effort (ne throw jamais)', () => {
    it('email vide → skip sans appel réseau, warn loggé', async () => {
      const fetchImpl = vi.fn();
      const logger = { warn: vi.fn() };
      await expect(
        trackGoal(
          { userEmail: '   ', goal: 'signup', sessionId: 's' },
          { fetchImpl, logger },
        ),
      ).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('fetch qui rejette (réseau/timeout) → résout sans throw, warn loggé', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const logger = { warn: vi.fn() };
      await expect(
        trackGoal(
          { userEmail: 'a@b.com', goal: 'signup', sessionId: 's' },
          { fetchImpl, logger },
        ),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
        expect.objectContaining({ goal: 'signup' }),
      );
    });

    it('réponse non-2xx → résout sans throw, warn loggé (pas de retry)', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('bad', { status: 400 }));
      const logger = { warn: vi.fn() };
      await expect(
        trackGoal(
          { userEmail: 'a@b.com', goal: 'signup', sessionId: 's' },
          { fetchImpl, logger },
        ),
      ).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1); // zéro retry
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('non-2xx'),
        expect.objectContaining({ status: 400 }),
      );
    });
  });
});
