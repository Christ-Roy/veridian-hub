/**
 * Fils « Mon IA » rangés dans l'app (lib/ia/fils.ts). Le CRM : route du plugin Twenty sur l'origine de
 * l'espace, jeton ES256 du Hub que le plugin vérifie par la clé publique. Le Hub n'appelle aucune autre adresse.
 */
import { createHash } from 'node:crypto';

import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ecrireFil, lireFil, origineCrmValide } from '@/lib/ia/fils';
import { jwksPublic } from '@/lib/mcp/identite';

let env: NodeJS.ProcessEnv;
const WS = '0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c';
const cible = { sessionId: 's-1', hubUserId: '53245ae1-6bf8-4ec6-870f-32d75b7c0281', tenantId: 't-1', workspaceId: WS, origine: 'https://acme.crm.app.veridian.site' };

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

describe('origineCrmValide', () => {
  it("n'accepte qu'un sous-domaine direct de l'hôte du CRM, en HTTPS", () => {
    expect(origineCrmValide('https://acme.crm.app.veridian.site', env)).toBe(true);
    for (const o of [
      'http://acme.crm.app.veridian.site',
      'https://crm.app.veridian.site',
      'https://a.b.crm.app.veridian.site',
      'https://acme.crm.app.veridian.site.evil.io',
      'https://acmecrm.app.veridian.site',
      'https://acme.crm.app.veridian.site/x',
      'https://acme.crm.app.veridian.site:8443',
      'https://169.254.169.254',
      null,
    ]) {
      expect(origineCrmValide(o, env), String(o)).toBe(false);
    }
  });
});

describe('fils du CRM : route du plugin, jeton ES256', () => {
  it('PUT vers <origine>/s/veridian-ia/fils/:session, jeton lié à l\'URL, au workspace et au corps', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const ok = await ecrireFil('crm', { ...cible, messages: [{ id: 'm1' }] }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://acme.crm.app.veridian.site/s/veridian-ia/fils/s-1');
    const corps = String(init.body);
    expect(JSON.parse(corps)).toEqual({ messages: [{ id: 'm1' }] });
    // Twenty retire Authorization des requêtes de ses fonctions de plugin : le jeton a son propre en-tête.
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBeUndefined();
    expect(init.redirect).toBe('manual');
    const jeton = String(h['X-Veridian-Ia-Jeton']);
    const { payload } = await jwtVerify(jeton, createLocalJWKSet(await jwksPublic(env)), { audience: url, issuer: 'https://app.veridian.site' });
    expect(payload).toMatchObject({ sub: cible.hubUserId, scope: 'ia.fils', tenant_id: 't-1', workspace_id: WS, session_id: 's-1' });
    expect(payload.corps_sha256).toBe(createHash('sha256').update(corps).digest('hex'));
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
  });

  it('GET signé sans paramètre : auteur et espace sont dans le jeton', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ messages: [{ id: 'm1' }] }));
    expect(await lireFil('crm', cible, { env, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([{ id: 'm1' }]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://acme.crm.app.veridian.site/s/veridian-ia/fils/s-1');
  });

  it("origine étrangère ou workspace absent : aucun appel", async () => {
    const fetchImpl = vi.fn();
    const f = fetchImpl as unknown as typeof fetch;
    expect(await ecrireFil('crm', { ...cible, origine: 'https://evil.io', messages: [] }, { env, fetchImpl: f })).toBe(false);
    expect(await ecrireFil('crm', { ...cible, workspaceId: null, messages: [] }, { env, fetchImpl: f })).toBe(false);
    expect(await lireFil('crm', { ...cible, origine: null }, { env, fetchImpl: f })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fils des autres apps : contrat HMAC inchangé', () => {
  it('Academy : PUT <ACADEMY_API_URL>/api/hub/ia/fils/:session signé', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await ecrireFil('academy', { ...cible, origine: 'https://evil.io', messages: [] }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://academy.app.veridian.site/api/hub/ia/fils/s-1');
    expect((init.headers as Record<string, string>)['X-Veridian-Hub-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ hub_user_id: cible.hubUserId, tenant_id: 't-1' });
  });
});
