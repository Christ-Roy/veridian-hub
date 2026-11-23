/** L'espace CRM servi sur une origine, demandé à son plugin (menace 8, docs/MON-IA.md). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signer = vi.hoisted(() => vi.fn(async (c: { audience: string }) => `jeton:${c.audience}`));
vi.mock('@/lib/mcp/identite', () => ({ signerPourRouteApp: signer }));

import { oublierEspacesCrm, verifierEspaceCrm, workspaceDeLOrigine } from '@/lib/ia/espace-crm';
import { refusSiCroisee } from '@/lib/ia/requete';

const env = { CRM_API_URL: 'https://crm.app.veridian.site' } as NodeJS.ProcessEnv;
const WS = '38627be0-428f-4924-aa67-4a35884ba7b4';
const AUTRE = '11111111-2222-4333-8444-555555555555';
const ORIGINE = 'https://robert.crm.app.veridian.site';
const repond = (ws: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify({ workspace_id: ws }), { status })) as unknown as typeof fetch;

beforeEach(() => {
  oublierEspacesCrm();
  signer.mockClear();
});

describe('workspaceDeLOrigine', () => {
  it('demande au plugin de l\'origine, jeton dans X-Veridian-Ia-Jeton lié à l\'URL exacte, sans suivre de redirection', async () => {
    const f = repond(WS);
    expect(await workspaceDeLOrigine(ORIGINE, 'hub-robert', { env, fetchImpl: f })).toEqual({ ok: true, workspaceId: WS });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGINE}/s/veridian-ia/espace`);
    expect(init.headers).toEqual({ 'X-Veridian-Ia-Jeton': `jeton:${ORIGINE}/s/veridian-ia/espace` });
    expect(init.redirect).toBe('manual');
    expect(signer.mock.calls[0][0]).toMatchObject({ hubUserId: 'hub-robert', claims: { scope: 'ia.espace' } });
  });

  it('SSRF : aucun appel sortant hors de https://<label>.crm.app.veridian.site', async () => {
    const f = repond(WS);
    for (const o of [
      'http://169.254.169.254',
      'https://169.254.169.254',
      'https://evil.com',
      'https://x.crm.app.veridian.site.evil.com',
      'https://a.b.crm.app.veridian.site',
      'http://robert.crm.app.veridian.site',
      'https://robert.crm.app.veridian.site:8443',
      'https://crm.app.veridian.site',
      'https://-x.crm.app.veridian.site',
      null,
      42,
    ]) {
      expect(await workspaceDeLOrigine(o, 'u', { env, fetchImpl: f }), String(o)).toEqual({ ok: false, verdict: 'origine_invalide' });
    }
    expect(f).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });

  it('redirection, 404, réponse illisible ou réseau coupé : non abouti, jamais un workspace', async () => {
    for (const f of [repond(WS, 302), repond(WS, 404), repond('pas-un-uuid'), repond(42)]) {
      expect(await workspaceDeLOrigine(ORIGINE, 'u', { env, fetchImpl: f })).toEqual({ ok: false, verdict: 'non_abouti' });
    }
    const panne = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect((await workspaceDeLOrigine(ORIGINE, 'u', { env, fetchImpl: panne })).ok).toBe(false);
  });

  it('une réponse est gardée 5 minutes, pas davantage', async () => {
    await workspaceDeLOrigine(ORIGINE, 'u', { env, fetchImpl: repond(WS), maintenant: 0 });
    const muet = repond(WS, 500);
    expect((await workspaceDeLOrigine(ORIGINE, 'u', { env, fetchImpl: muet, maintenant: 4 * 60_000 })).ok).toBe(true);
    expect((await workspaceDeLOrigine(ORIGINE, 'u', { env, fetchImpl: muet, maintenant: 6 * 60_000 })).ok).toBe(false);
  });
});

describe('verifierEspaceCrm', () => {
  it('le plugin sert un autre workspace : étrangère', async () => {
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond(AUTRE) })).toBe('origine_etrangere');
    oublierEspacesCrm();
    expect(await verifierEspaceCrm(ORIGINE, WS, 'u', { env, fetchImpl: repond(WS) })).toBe('ok');
  });
});

describe('refusSiCroisee', () => {
  // Pas de NextRequest ici : l'environnement de test filtre Origin et Sec-Fetch-* d'une Request, comme un navigateur.
  const req = (h: Record<string, string>) => ({ headers: new Headers(h), nextUrl: { origin: 'https://app.veridian.site' } });
  const e = { AUTH_URL: 'https://app.veridian.site' } as NodeJS.ProcessEnv;

  it('une page d\'un espace CRM (même site, autre origine) ne peut pas poser de question au nom de l\'utilisateur', () => {
    expect(refusSiCroisee(req({ 'sec-fetch-site': 'same-site', origin: ORIGINE }), e)?.status).toBe(403);
    expect(refusSiCroisee(req({ origin: ORIGINE }), e)?.status).toBe(403);
    expect(refusSiCroisee(req({ 'sec-fetch-site': 'cross-site' }), e)?.status).toBe(403);
  });

  it('la fenêtre du Hub passe', () => {
    expect(refusSiCroisee(req({ 'sec-fetch-site': 'same-origin', origin: 'https://app.veridian.site' }), e)).toBeNull();
    expect(refusSiCroisee(req({}), e)).toBeNull();
  });
});
