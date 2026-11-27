/**
 * Fils « Mon IA » rangés dans l'app (lib/ia/fils.ts), contrat HMAC. Le CRM n'en est plus : son chat natif range
 * ses fils lui-même.
 */
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ecrireFil, lireFil } from '@/lib/ia/fils';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

let env: NodeJS.ProcessEnv;
const cible = { sessionId: 's-1', hubUserId: '53245ae1-6bf8-4ec6-870f-32d75b7c0281', tenantId: 't-1' };

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  env = {
    MCP_SIGNING_JWK: JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'test-fils' }),
    CRM_API_URL: 'https://crm.app.veridian.site',
    ACADEMY_API_URL: 'https://academy.app.veridian.site',
    ACADEMY_HUB_API_SECRET: 's'.repeat(40),
    NEXT_PUBLIC_SITE_URL: 'https://app.veridian.site',
  } as NodeJS.ProcessEnv;
});

describe('fils du CRM : le Hub ne les range plus (chat natif, 23/11)', () => {
  it('aucun appel, ni au plugin ni ailleurs', async () => {
    const fetchImpl = vi.fn();
    const f = fetchImpl as unknown as typeof fetch;
    expect(await ecrireFil('crm', { ...cible, messages: [] }, { env, fetchImpl: f })).toBe(false);
    expect(await lireFil('crm', cible, { env, fetchImpl: f })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fils des autres apps : contrat HMAC inchangé', () => {
  it('Academy : PUT <ACADEMY_API_URL>/api/hub/ia/fils/:session signé', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await ecrireFil('academy', { ...cible, messages: [] }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://academy.app.veridian.site/api/hub/ia/fils/s-1');
    expect((init.headers as Record<string, string>)['X-Veridian-Hub-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ hub_user_id: cible.hubUserId, tenant_id: 't-1' });
  });
});

describe('fils des autres apps : version de signature', () => {
  const jouer = async () => {
    const vus: { url: string; methode: string; corps: string; h: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      vus.push({ url, methode: init?.method ?? 'GET', corps: String(init?.body ?? ''), h: init!.headers as Record<string, string> });
      return Response.json({ messages: [] });
    }) as unknown as typeof fetch;
    await lireFil('academy', cible, { env, fetchImpl });
    await ecrireFil('academy', { ...cible, messages: [] }, { env, fetchImpl });
    return vus;
  };
  afterEach(() => vi.unstubAllEnvs());
  it('HMAC_V2_APPS=academy : la lecture (query comprise) et l\'écriture PUT partent en v2', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'academy');
    const vus = await jouer();
    expect(vus.map((v) => v.methode)).toEqual(['GET', 'PUT']);
    expect(vus[0].url).toContain('?hub_user_id=');
    for (const v of vus) exigeV2(v.h, 's'.repeat(40), v.methode, v.url, v.corps);
  });
  it('variable absente : v1', async () => {
    for (const v of await jouer()) exigeV1(v.h, 's'.repeat(40), v.corps);
  });
});

describe('fil refusé par l\'app : la cause est journalisée, jamais le contenu (26/11)', () => {
  it('statut et code d\'erreur de l\'app dans [ia][fil][refus] ; ni messages ni adresse', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = (async () => new Response(JSON.stringify({ error: 'fil_autre_auteur' }), { status: 409 })) as unknown as typeof fetch;
    const ok = await ecrireFil('academy', { ...cible, messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'secret du fil' }] }] }, { env, fetchImpl: f });
    const lignes = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect([ok, lignes.length, JSON.parse(lignes[0])]).toEqual([false, 1, { tag: '[ia][fil][refus]', app: 'academy', statut: 409, erreur: 'fil_autre_auteur' }]);
    expect(lignes[0]).not.toContain('secret du fil');
  });
});

