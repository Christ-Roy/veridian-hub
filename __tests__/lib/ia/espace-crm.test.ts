/** Le lien origine ↔ workspace d'un espace CRM, demandé à son plugin (menace 8, docs/MON-IA.md). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signer = vi.hoisted(() => vi.fn(async (c: { audience: string }) => `jeton:${c.audience}`));
vi.mock('@/lib/mcp/identite', () => ({ signerPourRouteApp: signer }));

import { oublierEspacesCrm, verifierEspaceCrm } from '@/lib/ia/espace-crm';
import { refusSiCroisee } from '@/lib/ia/requete';

const env = { CRM_API_URL: 'https://crm.app.veridian.site' } as NodeJS.ProcessEnv;
const WS = '38627be0-428f-4924-aa67-4a35884ba7b4';
const ORIGINE = 'https://robert.crm.app.veridian.site';
const repond = (ws: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify({ workspace_id: ws }), { status })) as unknown as typeof fetch;

beforeEach(() => {
  oublierEspacesCrm();
  signer.mockClear();
});

describe('verifierEspaceCrm', () => {
  it('demande au plugin de l\'origine, avec un jeton lié à l\'URL exacte', async () => {
    const f = repond(WS);
    expect(await verifierEspaceCrm(ORIGINE, WS, 'hub-robert', { env, fetchImpl: f })).toBe('ok');
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGINE}/s/veridian-ia/espace`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer jeton:${ORIGINE}/s/veridian-ia/espace`);
    expect(signer.mock.calls[0][0]).toMatchObject({ hubUserId: 'hub-robert', claims: { scope: 'ia.espace', workspace_id: WS } });
  });

  it('le plugin sert un autre workspace : étrangère, et ce n\'est pas mis en mémoire', async () => {
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond('autre-ws') })).toBe('origine_etrangere');
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond(WS) })).toBe('ok');
  });

  it('origine hors du CRM : refusée sans aucun appel (pas de SSRF)', async () => {
    const f = repond(WS);
    for (const o of ['https://evil.io', 'https://a.b.crm.app.veridian.site', 'http://robert.crm.app.veridian.site', 'https://robert.crm.app.veridian.site.evil.io', null]) {
      expect(await verifierEspaceCrm(o, WS, 'u', { env, fetchImpl: f })).toBe('origine_invalide');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('plugin absent (404), réponse illisible ou réseau coupé : non abouti', async () => {
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond(WS, 404) })).toBe('non_abouti');
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond(42) })).toBe('non_abouti');
    const panne = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: panne })).toBe('non_abouti');
  });

  it('une concordance est gardée 10 minutes, pas davantage', async () => {
    await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond(WS), maintenant: 0 });
    const muet = repond(WS, 500);
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: muet, maintenant: 9 * 60_000 })).toBe('ok');
    expect(await verifierEspaceCrm(ORIGINE, 'autre-ws', 'u', { env, fetchImpl: muet, maintenant: 9 * 60_000 })).toBe('origine_etrangere');
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: muet, maintenant: 11 * 60_000 })).toBe('non_abouti');
  });
});

describe('refusSiCroisee', () => {
  // Pas de NextRequest ici : l'environnement de test filtre Origin et Sec-Fetch-* d'une Request, comme un navigateur.
  const req = (h: Record<string, string>) => ({ headers: new Headers(h), nextUrl: { origin: 'https://app.veridian.site' } });
  const e = { AUTH_URL: 'https://app.veridian.site' } as NodeJS.ProcessEnv;

  it('une page d\'un espace CRM (même site, autre origine) ne peut pas poser de question au nom de l\'utilisateur', async () => {
    expect(refusSiCroisee(req({ 'sec-fetch-site': 'same-site', origin: ORIGINE }), e)?.status).toBe(403);
    expect(refusSiCroisee(req({ origin: ORIGINE }), e)?.status).toBe(403);
    expect(refusSiCroisee(req({ 'sec-fetch-site': 'cross-site' }), e)?.status).toBe(403);
  });

  it('la fenêtre du Hub passe', () => {
    expect(refusSiCroisee(req({ 'sec-fetch-site': 'same-origin', origin: 'https://app.veridian.site' }), e)).toBeNull();
    expect(refusSiCroisee(req({}), e)).toBeNull();
  });
});
