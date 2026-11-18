// @vitest-environment node
//
// L'environnement par défaut du repo est `happy-dom` (cf. vitest.config.ts),
// qui applique la Same Origin Policy et bloque tout appel réseau sortant vers
// un autre hôte : `NetworkError: Cross-Origin Request Blocked`. Ce fichier
// parle au vrai engine, il lui faut donc le runtime Node et son `fetch` natif.

/**
 * Test d'intégration LIVE du client Analytics réécrit sur la surface engine.
 *
 * Prouve, contre le VRAI `analytics-engine.staging.veridian.site`, que les
 * routes appelées existent et répondent au format attendu — c'est précisément
 * ce que l'ancien client ne faisait plus : il ciblait les chemins de l'app
 * legacy décommissionnée et se prenait un 404 sur chaque appel, rendant
 * `/dashboard/admin/analytics` inopérante.
 * Cf. `todo/2026-07-28-autologin-analytics-contrat-et-etat-reel.md`.
 *
 * SKIPPÉ par défaut : ne tourne que si la clé plateforme staging est présente.
 * La CI unitaire ne l'a pas, ce fichier y est donc neutre.
 *
 * GARDE-FOUS :
 *   - staging uniquement, refus explicite de cibler la prod ;
 *   - **lecture seule** — aucun `provisionWorkspace`, qui créerait un workspace
 *     et enverrait un email à un owner. Le chemin d'écriture est couvert par
 *     les tests unitaires (corps de requête) ; ici on prouve que les routes
 *     de lecture répondent réellement.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  analyticsClient,
  isAnalyticsConfigured,
  AnalyticsNotConfiguredError,
} from '@/lib/analytics/client';

const STAGING_URL = 'https://analytics-engine.staging.veridian.site';
const KEY =
  process.env.ANALYTICS_ENGINE_STAGING_PLATFORM_ADMIN_KEY ??
  process.env.ANALYTICS_ADMIN_KEY ??
  '';

const LIVE = Boolean(KEY);

let savedUrl: string | undefined;
let savedKey: string | undefined;

beforeAll(() => {
  savedUrl = process.env.ANALYTICS_API_URL;
  savedKey = process.env.ANALYTICS_ADMIN_KEY;
  process.env.ANALYTICS_API_URL = STAGING_URL;
  process.env.ANALYTICS_ADMIN_KEY = KEY;
});

afterAll(() => {
  if (savedUrl === undefined) delete process.env.ANALYTICS_API_URL;
  else process.env.ANALYTICS_API_URL = savedUrl;
  if (savedKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
  else process.env.ANALYTICS_ADMIN_KEY = savedKey;
});

describe.skipIf(!LIVE)('client Analytics — intégration live (staging)', () => {
  it('ne cible jamais la production', () => {
    expect(process.env.ANALYTICS_API_URL).not.toContain('.app.veridian.site');
  });

  it(
    'getWorkspaceStatus répond sur un workspace inconnu (exists: false, pas 404)',
    async () => {
      // L'ancien client tapait `/api/admin/tenants` : 404 systématique.
      // La route vivante répond 200 avec un état structuré.
      const status = await analyticsClient.getWorkspaceStatus(
        `ghost${Date.now().toString(36)}`.slice(0, 20),
      );

      expect(status.exists).toBe(false);
      expect(status).toHaveProperty('workspace_id');
      expect(status).toHaveProperty('tracking');
      expect(status).toHaveProperty('gsc');
      expect(status).toHaveProperty('snippet_html');
    },
    30_000,
  );

  it(
    'la clé plateforme est bien acceptée par l’engine',
    async () => {
      // Une clé rejetée ferait remonter une AnalyticsApiError 401 ; un 200
      // prouve que l'authentification Bearer passe de bout en bout.
      await expect(
        analyticsClient.getWorkspaceStatus('probe000'),
      ).resolves.toMatchObject({ exists: false });
    },
    30_000,
  );

  it(
    'listApiKeys sur un workspace inconnu échoue proprement, sans crash',
    async () => {
      // On veut une AnalyticsApiError typée (status HTTP exploitable par l'UI),
      // pas une TypeError ou un JSON.parse qui explose.
      await analyticsClient.listApiKeys('ghostws000').then(
        (res) => {
          // Certains engines répondent 200 + liste vide plutôt qu'une erreur :
          // les deux comportements sont acceptables, on vérifie juste la forme.
          expect(res).toHaveProperty('api_keys');
        },
        (err) => {
          expect(err.name).toBe('AnalyticsApiError');
          expect(typeof err.status).toBe('number');
        },
      );
    },
    30_000,
  );
});

describe('client Analytics — configuration', () => {
  it('isAnalyticsConfigured reflète la présence des deux variables', () => {
    const url = process.env.ANALYTICS_API_URL;
    const key = process.env.ANALYTICS_ADMIN_KEY;

    process.env.ANALYTICS_API_URL = 'https://x.test';
    delete process.env.ANALYTICS_ADMIN_KEY;
    expect(isAnalyticsConfigured()).toBe(false);

    process.env.ANALYTICS_ADMIN_KEY = 'k';
    expect(isAnalyticsConfigured()).toBe(true);

    if (url === undefined) delete process.env.ANALYTICS_API_URL;
    else process.env.ANALYTICS_API_URL = url;
    if (key === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = key;
  });

  it('signale une configuration absente par une erreur dédiée et lisible', async () => {
    const url = process.env.ANALYTICS_API_URL;
    const key = process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.ANALYTICS_API_URL;
    delete process.env.ANALYTICS_ADMIN_KEY;

    // C'est le cas RÉEL en prod aujourd'hui : ANALYTICS_ADMIN_KEY n'est
    // déployée dans aucun job Nomad. L'UI doit pouvoir le dire à Robert
    // plutôt que d'afficher une erreur opaque.
    await expect(
      analyticsClient.getWorkspaceStatus('x'),
    ).rejects.toBeInstanceOf(AnalyticsNotConfiguredError);

    if (url === undefined) delete process.env.ANALYTICS_API_URL;
    else process.env.ANALYTICS_API_URL = url;
    if (key === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = key;
  });
});
