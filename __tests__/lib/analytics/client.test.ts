/**
 * Tests du client Analytics réécrit sur la surface engine
 * (`/api/admin/platform/*`, fork staminads).
 *
 * Ce qu'on verrouille ici, c'est ce que l'ancien client faisait mal et qui
 * l'avait rendu inopérant sans que personne ne le voie :
 *   - la forme des appels (POST, chemin `/api/admin/platform/<route>`,
 *     `Authorization: Bearer`), et non des routes REST de l'app legacy morte ;
 *   - la traduction des noms de champs camelCase → snake_case attendu par
 *     l'engine (`siteUrl` → `siteUrl`, `workspaceId` → `workspace_id`) ;
 *   - une configuration absente signalée par une erreur DÉDIÉE et lisible —
 *     c'est le cas réel en production, où `ANALYTICS_ADMIN_KEY` n'est déployée
 *     dans aucun job Nomad.
 *
 * Cf. `todo/2026-07-28-autologin-analytics-contrat-et-etat-reel.md`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  analyticsClient,
  isAnalyticsConfigured,
  AnalyticsApiError,
  AnalyticsNotConfiguredError,
} from '@/lib/analytics/client';

const BASE = 'https://analytics-engine.test.veridian.site';
const KEY = 'platform-admin-key';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Dernier appel capturé, décomposé pour des assertions lisibles. */
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

beforeEach(() => {
  process.env.ANALYTICS_API_URL = BASE;
  process.env.ANALYTICS_ADMIN_KEY = KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('forme des appels', () => {
  it('tape /api/admin/platform/* en POST avec un Bearer, jamais les routes legacy', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { workspace_id: 'acme', exists: true }),
    );

    await analyticsClient.getWorkspaceStatus('acme');
    const call = lastCall();

    expect(call.url).toBe(`${BASE}/api/admin/platform/workspaces.status`);
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toEqual({ workspace_id: 'acme' });
    // L'ancien client tapait /api/admin/tenants — la garantie qui manquait.
    expect(call.url).not.toContain('/api/admin/tenants');
  });

  it("retire les slashes finaux de l'URL de base", async () => {
    process.env.ANALYTICS_API_URL = `${BASE}///`;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { exists: false }));

    await analyticsClient.getWorkspaceStatus('x');

    expect(lastCall().url).toBe(`${BASE}/api/admin/platform/workspaces.status`);
  });

  it('ne mélange jamais deux workspaces dans un même appel', async () => {
    // Une nouvelle Response par appel : un corps de Response ne se lit
    // qu'une fois, `mockResolvedValue` en réutiliserait l'instance.
    fetchMock.mockImplementation(async () => jsonResponse(200, { exists: false }));

    await analyticsClient.getWorkspaceStatus('premier');
    await analyticsClient.getWorkspaceStatus('second');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastCall().body).toEqual({ workspace_id: 'second' });
  });
});

describe('provisionWorkspace', () => {
  it("traduit les champs et n'envoie que les optionnels fournis", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { workspace_id: 'boulangerie', api_key: 'stam_live_x' }),
    );

    await analyticsClient.provisionWorkspace({
      name: 'Boulangerie Dupont',
      email: 'contact@boulangerie.test',
      siteUrl: 'https://boulangerie.test',
    });

    const call = lastCall();
    expect(call.url).toBe(`${BASE}/api/admin/platform/tenants.provision`);
    expect(call.body).toEqual({
      name: 'Boulangerie Dupont',
      email: 'contact@boulangerie.test',
      siteUrl: 'https://boulangerie.test',
    });
    // Pas de clés à `undefined` : l'engine valide strictement le DTO.
    expect(Object.keys(call.body)).not.toContain('workspace_id');
    expect(Object.keys(call.body)).not.toContain('template');
  });

  it('passe workspace_id en snake_case et le template quand ils sont fournis', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { workspace_id: 'resto' }));

    await analyticsClient.provisionWorkspace({
      name: 'Resto',
      email: 'c@resto.test',
      siteUrl: 'https://resto.test',
      workspaceId: 'resto_le_coin',
      template: 'vitrine',
      timezone: 'Europe/Paris',
    });

    expect(lastCall().body).toMatchObject({
      workspace_id: 'resto_le_coin',
      template: 'vitrine',
      timezone: 'Europe/Paris',
    });
  });
});

describe('gestion des erreurs', () => {
  it("remonte le message de l'engine dans une AnalyticsApiError typée", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { message: 'workspace_id already taken' }),
    );

    await expect(
      analyticsClient.provisionWorkspace({
        name: 'X',
        email: 'x@x.test',
        siteUrl: 'https://x.test',
      }),
    ).rejects.toMatchObject({
      name: 'AnalyticsApiError',
      status: 409,
      message: 'workspace_id already taken',
    });
  });

  it('reste exploitable quand la réponse d’erreur n’est pas du JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    const err = await analyticsClient
      .getWorkspaceStatus('acme')
      .catch((e) => e as AnalyticsApiError);

    expect(err).toBeInstanceOf(AnalyticsApiError);
    expect(err.status).toBe(502);
    expect(err.message).toContain('HTTP 502');
  });

  it('signale une configuration absente sans jamais appeler le réseau', async () => {
    // Cas réel en prod : ANALYTICS_ADMIN_KEY absente des jobs Nomad.
    delete process.env.ANALYTICS_ADMIN_KEY;

    await expect(analyticsClient.getWorkspaceStatus('acme')).rejects.toBeInstanceOf(
      AnalyticsNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nomme la variable manquante pour que l'UI soit actionnable", async () => {
    delete process.env.ANALYTICS_API_URL;

    const err = await analyticsClient
      .getWorkspaceStatus('acme')
      .catch((e) => e as Error);

    expect(err.message).toContain('ANALYTICS_API_URL');
  });
});

describe('isAnalyticsConfigured', () => {
  it('exige les DEUX variables', () => {
    expect(isAnalyticsConfigured()).toBe(true);

    delete process.env.ANALYTICS_ADMIN_KEY;
    expect(isAnalyticsConfigured()).toBe(false);

    process.env.ANALYTICS_ADMIN_KEY = KEY;
    delete process.env.ANALYTICS_API_URL;
    expect(isAnalyticsConfigured()).toBe(false);
  });
});

describe('clés API', () => {
  it('provisionApiKey transmet le rôle demandé', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { api_key: 'stam_live_y' }));

    await analyticsClient.provisionApiKey('acme', { role: 'viewer', name: 'hub-pull' });

    expect(lastCall().body).toEqual({
      workspace_id: 'acme',
      role: 'viewer',
      name: 'hub-pull',
    });
  });

  it('revokeApiKey cible bien le préfixe', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { revoked: true }));

    await analyticsClient.revokeApiKey('acme', 'stam_live_abc');

    expect(lastCall().url).toBe(
      `${BASE}/api/admin/platform/workspaces.revokeApiKey`,
    );
    expect(lastCall().body).toEqual({
      workspace_id: 'acme',
      prefix: 'stam_live_abc',
    });
  });
});
