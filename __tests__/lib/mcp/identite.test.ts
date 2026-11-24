// @vitest-environment node
/** Les jetons que signe le Hub : celui d'un programme n'ouvre aucune app, celui d'une app n'ouvre aucun programme. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { AUDIENCE_PROGRAMME, cleSignature, jwksPublic, signerAction, signerPourApp, signerPourProgramme } from '@/lib/mcp/identite';

const dir = mkdtempSync(path.join(tmpdir(), 'identite-'));
writeFileSync(path.join(dir, 'hub-url'), 'http://hub.test\n');
process.env.PROGRAMME_HUB_URL_FICHIER = path.join(dir, 'hub-url'); // lu au chargement de la passerelle

let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  env = { NODE_ENV: 'test', MCP_SIGNING_JWK: JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'k1' }) };
});
const lire = async (t: string, audience: string) => (await jwtVerify(t, createLocalJWKSet((await jwksPublic(env)) as { keys: JWK[] }), { audience })).payload;
const APP = { audience: 'https://crm.test/mcp', hubUserId: 'u-1', email: 'a@example.test', clientId: 'c-1', scope: 'veridian' };

describe('signerPourProgramme', () => {
  it('30 s, usage unique, aucune identité d\'utilisateur', async () => {
    const p = await lire(await signerPourProgramme('prog-1', env), AUDIENCE_PROGRAMME);
    expect(p.exp! - p.iat!).toBe(30);
    expect(Object.keys(p).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    expect(p.sub).toBe('prog-1');
    const autre = await lire(await signerPourProgramme('prog-1', env), AUDIENCE_PROGRAMME);
    expect(autre.jti).not.toBe(p.jti);
  });

  it('la passerelle le reconnaît ; une app le refuse, et la passerelle refuse celui d\'une app', async () => {
    const { verifierJeton } = (await import('../../../programme/passerelle.mjs')) as typeof import('../../../programme/passerelle.mjs');
    const jwks = await jwksPublic(env);
    const t = await signerPourProgramme('prog-1', env);
    const { iss } = await lire(t, AUDIENCE_PROGRAMME);
    const opt = { fetchImpl: (async () => Response.json(jwks)) as unknown as typeof fetch, emetteur: iss as string };
    expect(await verifierJeton(`Bearer ${t}`, opt)).toBe('prog-1');
    await expect(lire(t, APP.audience)).rejects.toThrow();
    expect(await verifierJeton(`Bearer ${await signerPourApp(APP, env)}`, opt)).toBeNull();
  });

  it('sans clé : erreur, jamais un jeton non signé', async () => {
    await expect(signerPourProgramme('p', { NODE_ENV: 'test' })).rejects.toThrow('MCP_SIGNING_JWK');
  });
});

describe('signerPourApp et la clé', () => {
  it('tenant_id n\'est signé que s\'il est choisi', async () => {
    expect(await lire(await signerPourApp(APP, env), APP.audience)).not.toHaveProperty('tenant_id');
    expect(await lire(await signerPourApp({ ...APP, tenantId: 't-1' }, env), APP.audience)).toMatchObject({ sub: 'u-1', tenant_id: 't-1', client_id: 'c-1' });
  });

  it('org_role n\'est signé qu\'avec un espace choisi', async () => {
    expect(await lire(await signerPourApp({ ...APP, orgRole: 'admin' }, env), APP.audience)).not.toHaveProperty('org_role');
    expect(await lire(await signerPourApp({ ...APP, tenantId: 't-1', orgRole: 'admin' }, env), APP.audience)).toMatchObject({ tenant_id: 't-1', org_role: 'admin' });
  });

  it('un jeton d\'action porte toujours act, tenant_id et jti, et n\'est jamais complet', async () => {
    const p = await lire(await signerAction({ audience: APP.audience, hubUserId: 'u', email: 'a@b.fr', tenantId: 't', app: 'prospection', scope: 'crm:tache.ecrire', jti: 'j', ttlS: 120 }, env), APP.audience);
    expect(p).toMatchObject({ act: { sub: 'app:prospection' }, tenant_id: 't', jti: 'j', scope: 'crm:tache.ecrire', client_id: 'app:prospection' });
    expect(p.exp! - p.iat!).toBe(120);
  });

  it('le JWKS public ne rend jamais la partie privée', async () => {
    const { keys } = await jwksPublic(env);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('d');
    expect(await jwksPublic({ NODE_ENV: 'test' })).toEqual({ keys: [] });
    await expect(cleSignature({ NODE_ENV: 'test', MCP_SIGNING_JWK: '{"kty":"RSA"}' })).rejects.toThrow('P-256');
  });
});
