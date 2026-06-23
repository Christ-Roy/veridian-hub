/**
 * Tests du client engine Analytics (lib/prospect/engine-client.ts).
 *
 * Couvre le comportement réel : résolution config ENV, garde-fou isConfigured,
 * login programmatique, retry 401 → re-login, pagination par curseur, et la
 * remontée d'erreur sur statut non-ok. `fetch` global est mocké.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EngineClient,
  engineConfigFromEnv,
  type EngineClientConfig,
  type ExportedEvent,
} from '@/lib/prospect/engine-client';

const CONFIG: EngineClientConfig = {
  baseUrl: 'https://engine.test',
  workspaceId: 'ws_test',
  adminEmail: 'admin@veridian.site',
  adminPassword: 's3cret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function evt(id: string): ExportedEvent {
  return {
    id,
    session_id: 'sess',
    user_id: 'u1',
    name: 'screen_view',
    path: '/audit/x',
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
    goal_name: '',
    goal_value: 0,
    goal_timestamp: null,
    max_scroll: 0,
    duration: 0,
  };
}

describe('engineConfigFromEnv', () => {
  it('applique les défauts prod quand l’ENV est vide', () => {
    const cfg = engineConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe('https://analytics-engine.app.veridian.site');
    expect(cfg.workspaceId).toBe('vrd_veridian_site_prod');
    expect(cfg.adminEmail).toBe('');
    expect(cfg.adminPassword).toBe('');
  });

  it('lit les overrides ENV', () => {
    const cfg = engineConfigFromEnv({
      ENGINE_BASE_URL: 'https://x',
      ENGINE_WORKSPACE_ID: 'w',
      ENGINE_ADMIN_EMAIL: 'a@b.c',
      ENGINE_ADMIN_PASSWORD: 'p',
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      baseUrl: 'https://x',
      workspaceId: 'w',
      adminEmail: 'a@b.c',
      adminPassword: 'p',
    });
  });
});

describe('EngineClient.isConfigured', () => {
  it('false si credentials admin absents (garde-fou skip pull)', () => {
    expect(
      new EngineClient({ ...CONFIG, adminEmail: '', adminPassword: '' }).isConfigured(),
    ).toBe(false);
    expect(
      new EngineClient({ ...CONFIG, adminPassword: '' }).isConfigured(),
    ).toBe(false);
  });

  it('true si email ET password présents', () => {
    expect(new EngineClient(CONFIG).isConfigured()).toBe(true);
  });
});

describe('EngineClient.exportPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('login puis export : passe le Bearer + les bons query params', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1' })) // login
      .mockResolvedValueOnce(
        jsonResponse({ data: [evt('e1')], next_cursor: null, has_more: false }),
      );

    const client = new EngineClient(CONFIG);
    const page = await client.exportPage({ since: '2026-06-15', until: '2026-06-17' });

    expect(page.data).toHaveLength(1);
    // 1er appel = login
    expect(fetchMock.mock.calls[0][0].toString()).toContain('/api/auth.login');
    // 2e appel = export avec workspace_id, until, since, Bearer
    const exportUrl = fetchMock.mock.calls[1][0].toString();
    expect(exportUrl).toContain('/api/export.userEvents');
    expect(exportUrl).toContain('workspace_id=ws_test');
    expect(exportUrl).toContain('until=2026-06-17');
    expect(exportUrl).toContain('since=2026-06-15');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('retry sur 401 : re-login puis rejoue la requête avec le token frais', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-old' })) // login initial
      .mockResolvedValueOnce(new Response('expired', { status: 401 })) // export → 401
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-new' })) // re-login
      .mockResolvedValueOnce(
        jsonResponse({ data: [evt('e1')], next_cursor: null, has_more: false }),
      );

    const client = new EngineClient(CONFIG);
    const page = await client.exportPage({ since: '2026-06-15', until: '2026-06-17' });

    expect(page.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // la requête rejouée porte le nouveau token
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer tok-new');
  });

  it('throw si login échoue', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    const client = new EngineClient(CONFIG);
    await expect(
      client.exportPage({ since: '2026-06-15', until: '2026-06-17' }),
    ).rejects.toThrow(/engine login 403/);
  });

  it('throw si l’export renvoie un statut non-ok (hors 401)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1' }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = new EngineClient(CONFIG);
    await expect(
      client.exportPage({ since: '2026-06-15', until: '2026-06-17' }),
    ).rejects.toThrow(/export\.userEvents 500/);
  });

  it('throw si le login ne renvoie pas de token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = new EngineClient(CONFIG);
    await expect(
      client.exportPage({ since: '2026-06-15', until: '2026-06-17' }),
    ).rejects.toThrow(/pas de token/);
  });
});

describe('EngineClient.exportAll', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pagine par curseur jusqu’à has_more=false et yield chaque page', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1' })) // login
      .mockResolvedValueOnce(
        jsonResponse({ data: [evt('e1')], next_cursor: 'c1', has_more: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [evt('e2')], next_cursor: null, has_more: false }),
      );

    const client = new EngineClient(CONFIG);
    const pages: ExportedEvent[][] = [];
    for await (const p of client.exportAll('2026-06-15', '2026-06-17')) pages.push(p);

    expect(pages).toHaveLength(2);
    expect(pages[0][0].id).toBe('e1');
    expect(pages[1][0].id).toBe('e2');
    // 2e page de données utilise le curseur, pas `since`
    const secondExportUrl = fetchMock.mock.calls[2][0].toString();
    expect(secondExportUrl).toContain('cursor=c1');
    expect(secondExportUrl).not.toContain('since=');
  });

  it('n’yield pas de page vide (data.length=0)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1' }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [], next_cursor: null, has_more: false }),
      );

    const client = new EngineClient(CONFIG);
    const pages: ExportedEvent[][] = [];
    for await (const p of client.exportAll('2026-06-15', '2026-06-17')) pages.push(p);

    expect(pages).toHaveLength(0);
  });

  it('ANTI-LOOP : curseur non-progressant (même next_cursor) → s’arrête, pas de boucle infinie', async () => {
    // L'engine ment : il renvoie TOUJOURS le même curseur 'stuck' avec
    // has_more:true. Sans garde-fou, exportAll bouclerait à l'infini (hang +
    // OOM du cron prod). On vérifie qu'il s'arrête après détection du curseur
    // qui ne progresse pas — le test TERMINE (sinon il timeout = régression).
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1' }));
    // Factory : NOUVELLE Response à chaque appel (sinon le body est consommé
    // au 1er .json() → "Body already used"). L'engine renvoie toujours 'stuck'.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ data: [evt('e1')], next_cursor: 'stuck', has_more: true }),
      ),
    );

    const client = new EngineClient(CONFIG);
    const pages: ExportedEvent[][] = [];
    for await (const p of client.exportAll('2026-06-15', '2026-06-17')) pages.push(p);

    // 1ère page (cursor null→'stuck') yieldée, 2e page (cursor 'stuck'==prev)
    // détecte le non-progrès et coupe. Donc ≤ 2 pages, JAMAIS l'infini.
    expect(pages.length).toBeLessThanOrEqual(2);
    expect(pages.length).toBeGreaterThan(0);
  });
});
