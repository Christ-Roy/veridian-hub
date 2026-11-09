/**
 * Serveur OAuth 2.1 de la porte MCP (docs/CONTRAT-MCP.md) : enregistrement, PKCE, code à usage
 * unique, rotation des jetons, révocation, « déconnecter partout ».
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { mcpResource } from '@/lib/mcp/config';
import { empreinte } from '@/lib/mcp/crypto';
import {
  creerCode,
  echangerCode,
  enregistrerClient,
  redirectUriValide,
  renouveler,
  revoquer,
  validerDemande,
  verifierAcces,
} from '@/lib/mcp/oauth';

import { fausseBase, type FausseBase } from './fausse-base';

const HUB_USER = '11111111-2222-3333-4444-555555555555';
const RETOUR = 'http://localhost:33418/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

let db: FausseBase;
beforeEach(async () => {
  db = fausseBase();
  await db.user.create({ data: { id: 'u1', supabaseUserId: HUB_USER, email: 'client@exemple.fr', name: 'Client', emailVerified: new Date() } });
});

async function connexion() {
  const c = await enregistrerClient(db as never, { client_name: 'Claude', redirect_uris: [RETOUR] });
  const k = pkce();
  const v = await validerDemande(db as never, {
    response_type: 'code', client_id: c.client_id, redirect_uri: RETOUR,
    code_challenge: k.challenge, code_challenge_method: 'S256', state: 'xyz', resource: mcpResource(),
  });
  if (!v.ok) throw new Error('demande refusée');
  const code = await creerCode(db as never, v.demande, HUB_USER);
  return { c, k, code };
}

describe('adresses de retour', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['http://localhost:5555/cb', true],
    ['http://127.0.0.1/cb', true],
    ['cursor://anysphere.cursor-retrieval/oauth/callback', true],
    ['http://evil.example/cb', false],
    ['javascript:alert(1)', false],
    ['https://claude.ai/cb#frag', false],
    ['pas une url', false],
  ])('%s → %s', (u, attendu) => {
    expect(redirectUriValide(u)).toBe(attendu);
  });
});

describe('enregistrement', () => {
  it('refuse un client confidentiel', async () => {
    await expect(enregistrerClient(db as never, { redirect_uris: [RETOUR], token_endpoint_auth_method: 'client_secret_basic' })).rejects.toMatchObject({ code: 'invalid_client_metadata' });
  });
  it('refuse une adresse de retour http publique', async () => {
    await expect(enregistrerClient(db as never, { redirect_uris: ['http://evil.example/cb'] })).rejects.toMatchObject({ code: 'invalid_redirect_uri' });
  });
});

describe('demande d\'autorisation', () => {
  it('client inconnu ou adresse non enregistrée : fatale, jamais redirigée', async () => {
    const c = await enregistrerClient(db as never, { redirect_uris: [RETOUR] });
    const a = await validerDemande(db as never, { client_id: 'mcpc_x', redirect_uri: RETOUR });
    const b = await validerDemande(db as never, { client_id: c.client_id, redirect_uri: 'https://evil.example/cb' });
    expect(a).toMatchObject({ ok: false, fatale: true });
    expect(b).toMatchObject({ ok: false, fatale: true });
  });
  it('sans PKCE S256 : refusée, rendue au client', async () => {
    const c = await enregistrerClient(db as never, { redirect_uris: [RETOUR] });
    const v = await validerDemande(db as never, { response_type: 'code', client_id: c.client_id, redirect_uri: RETOUR, code_challenge: 'abc', code_challenge_method: 'plain' });
    expect(v).toMatchObject({ ok: false, fatale: false });
  });
  it('autre ressource : invalid_target', async () => {
    const c = await enregistrerClient(db as never, { redirect_uris: [RETOUR] });
    const v = await validerDemande(db as never, { response_type: 'code', client_id: c.client_id, redirect_uri: RETOUR, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://ailleurs.example/mcp' });
    expect(v.ok === false && v.erreur.code).toBe('invalid_target');
  });
});

describe('échange du code', () => {
  it('parcours complet : le jeton d\'accès ouvre la porte au bon compte', async () => {
    const { c, k, code } = await connexion();
    const t = await echangerCode(db as never, { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: k.verifier, resource: mcpResource() });
    expect(t.token_type).toBe('Bearer');
    const qui = await verifierAcces(db as never, t.access_token);
    expect(qui).toMatchObject({ hubUserId: HUB_USER, clientId: c.client_id, email: 'client@exemple.fr' });
  });
  it('en base : empreintes seulement, jamais le jeton', async () => {
    const { c, k, code } = await connexion();
    const t = await echangerCode(db as never, { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: k.verifier });
    const stocke = JSON.stringify([db.oauthToken.lignes, db.oauthCode.lignes]);
    expect(stocke).not.toContain(t.access_token);
    expect(stocke).not.toContain(code);
    expect(db.oauthToken.lignes.some((l) => l.tokenHash === empreinte(t.access_token))).toBe(true);
  });
  it('code rejoué : refusé', async () => {
    const { c, k, code } = await connexion();
    const p = { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: k.verifier };
    await echangerCode(db as never, p);
    await expect(echangerCode(db as never, p)).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('mauvais vérificateur PKCE : refusé', async () => {
    const { c, code } = await connexion();
    await expect(echangerCode(db as never, { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: pkce().verifier })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('autre client : refusé', async () => {
    const { k, code } = await connexion();
    const autre = await enregistrerClient(db as never, { redirect_uris: [RETOUR] });
    await expect(echangerCode(db as never, { code, client_id: autre.client_id, redirect_uri: RETOUR, code_verifier: k.verifier })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('code expiré : refusé', async () => {
    const { c, k, code } = await connexion();
    db.oauthCode.lignes[0].expiresAt = new Date(Date.now() - 1000);
    await expect(echangerCode(db as never, { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: k.verifier })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});

describe('jetons', () => {
  async function jetons() {
    const { c, k, code } = await connexion();
    return { c, t: await echangerCode(db as never, { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: k.verifier }) };
  }

  it('rotation : le nouveau jeton marche, l\'ancien renouvellement rejoué coupe toute la connexion', async () => {
    const { c, t } = await jetons();
    const t2 = await renouveler(db as never, { refresh_token: t.refresh_token, client_id: c.client_id });
    expect(await verifierAcces(db as never, t2.access_token)).not.toBeNull();
    await expect(renouveler(db as never, { refresh_token: t.refresh_token, client_id: c.client_id })).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await verifierAcces(db as never, t2.access_token)).toBeNull();
  });
  it('jeton d\'accès expiré : refusé', async () => {
    const { t } = await jetons();
    db.oauthToken.lignes.find((l) => l.kind === 'access')!.expiresAt = new Date(Date.now() - 1);
    expect(await verifierAcces(db as never, t.access_token)).toBeNull();
  });
  it('révocation : coupe accès et renouvellement', async () => {
    const { c, t } = await jetons();
    await revoquer(db as never, t.refresh_token);
    expect(await verifierAcces(db as never, t.access_token)).toBeNull();
    await expect(renouveler(db as never, { refresh_token: t.refresh_token, client_id: c.client_id })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('« déconnecter partout » coupe aussi les IA', async () => {
    const { c, t } = await jetons();
    db.user.lignes[0].sessionsValidAfter = new Date(Date.now() + 1000);
    expect(await verifierAcces(db as never, t.access_token)).toBeNull();
    await expect(renouveler(db as never, { refresh_token: t.refresh_token, client_id: c.client_id })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('compte supprimé ou adresse non prouvée : refusé', async () => {
    const { t } = await jetons();
    db.user.lignes[0].emailVerified = null;
    expect(await verifierAcces(db as never, t.access_token)).toBeNull();
  });
  it('un jeton de renouvellement n\'ouvre pas la porte', async () => {
    const { t } = await jetons();
    expect(await verifierAcces(db as never, t.refresh_token)).toBeNull();
  });
});

describe('connexions IA (Réglages > Sécurité)', () => {
  it('liste la connexion active, la coupe, et refuse de couper celle d\'un autre compte', async () => {
    const { connexionsActives, couperConnexion } = await import('@/lib/mcp/connexions');
    const { c, k, code } = await connexion();
    const t = await echangerCode(db as never, { code, client_id: c.client_id, redirect_uri: RETOUR, code_verifier: k.verifier });
    const [cx] = await connexionsActives(db as never, HUB_USER);
    expect(cx.client).toBe('Claude');
    expect(await couperConnexion(db as never, 'autre-compte', cx.id)).toBe(false);
    expect(await verifierAcces(db as never, t.access_token)).not.toBeNull();
    expect(await couperConnexion(db as never, HUB_USER, cx.id)).toBe(true);
    expect(await verifierAcces(db as never, t.access_token)).toBeNull();
    expect(await connexionsActives(db as never, HUB_USER)).toEqual([]);
  });
});
