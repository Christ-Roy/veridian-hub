// @vitest-environment node
/** Le dialogue OIDC contre un VRAI serveur (jetable) : tout ce qu'un fournisseur peut fausser est refusé, et le témoin passe. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { demarrer, ouvrir, sceller, terminer } from '@/lib/federation/oidc';
import type { IdpPret } from '@/lib/federation/idp';

const admis = vi.hoisted(() => ({ oui: true }));
vi.mock('@/lib/federation/idp', async (o) => ({ ...(await o<object>()), adresseAcceptee: () => admis.oui }));

import { ouvrirIdp, type Mensonge } from '../../../e2e/systeme-sso/lib/idp-jetable';

let idp: Awaited<ReturnType<typeof ouvrirIdp>>;
let i: IdpPret;
const RETOUR = 'https://hub.test/api/auth/federation/callback';
beforeAll(async () => {
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  idp = await ouvrirIdp(); // 127.0.0.1 : refusé en vrai, admis ici par le mock ci-dessous
  i = { id: 'idp1', tenantId: 'T', issuer: idp.issuer, clientId: idp.client.id, secret: idp.client.secret, domaines: ['client.test'], creationAuto: false, test: true };
});
afterAll(() => idp.fermer());
beforeEach(() => { idp.mentir(null); idp.dire({ sub: 'u-1', email: 'Jean@Client.test', email_verified: true, name: 'Jean' }); });

async function aller() {
  const d = await demarrer(i, RETOUR);
  const r = await fetch(d.url, { redirect: 'manual' });
  return { t: ouvrir(d.cookie)!, retour: new URL(r.headers.get('location')!), url: new URL(d.url) };
}

describe('demarrer', () => {
  it('code, PKCE S256, state et nonce neufs, retour exact ; la transaction se relit, et périt', async () => {
    const [a, b] = [await aller(), await aller()];
    const p = a.url.searchParams;
    expect([p.get('response_type'), p.get('code_challenge_method'), p.get('redirect_uri'), p.get('client_id')]).toEqual(['code', 'S256', RETOUR, idp.client.id]);
    expect([a.t.state === b.t.state, a.t.nonce === b.t.nonce, a.t.verifier === b.t.verifier]).toEqual([false, false, false]);
    const c = sceller({ idp: 'x', state: 's', nonce: 'n', verifier: 'v', exp: 1_000 });
    expect([ouvrir(c, 999_000)?.idp, ouvrir(c, 1_000_001), ouvrir(undefined), ouvrir('v1.a.b.c'), ouvrir(`${c.slice(0, -3)}AAA`, 999_000)]).toEqual(['x', null, null, null, null]);
  });
});

describe('terminer', () => {
  it('témoin : l\'identité dite, adresse en minuscules', async () => {
    const x = await aller();
    expect(await terminer(i, x.t, x.retour)).toEqual({ sub: 'u-1', email: 'jean@client.test', emailNie: false, nom: 'Jean' });
  });
  it.each<[Mensonge]>([['nonce'], ['audience'], ['emetteur'], ['signature'], ['expire']])('jeton faux (%s) : refusé', async (m) => {
    idp.mentir(m);
    const x = await aller();
    await expect(terminer(i, x.t, x.retour)).rejects.toThrow();
  });
  it('code rejoué, state d\'une autre transaction, code d\'un autre navigateur, code absent, erreur du fournisseur : refusés', async () => {
    const x = await aller();
    await terminer(i, x.t, x.retour);
    await expect(terminer(i, x.t, x.retour), 'rejoué').rejects.toThrow();
    const [a, b] = [await aller(), await aller()];
    await expect(terminer(i, b.t, a.retour), 'state').rejects.toThrow();
    const force = new URL(a.retour);
    force.searchParams.set('state', b.t.state);
    await expect(terminer(i, b.t, force), 'PKCE : le code d\'un autre').rejects.toThrow();
    const sans = new URL(RETOUR);
    sans.searchParams.set('state', a.t.state);
    await expect(terminer(i, a.t, sans)).rejects.toThrow();
    sans.searchParams.set('error', 'access_denied');
    await expect(terminer(i, a.t, sans)).rejects.toThrow();
  });
  it('adresse niée par le fournisseur : dite ; absente : nulle ; non dite : pas niée', async () => {
    const lire = async (x: Parameters<typeof idp.dire>[0]) => { idp.dire(x); const a = await aller(); return terminer(i, a.t, a.retour); };
    expect(await lire({ sub: 's', email: 'a@client.test', email_verified: false })).toMatchObject({ emailNie: true });
    expect(await lire({ sub: 's', email: 'a@client.test' })).toMatchObject({ emailNie: false });
    expect(await lire({ sub: 's' })).toMatchObject({ email: null });
  });
  it('adresses publiées par le fournisseur qui visent ailleurs que chez lui : refusé avant d\'envoyer code ou secret', async () => {
    admis.oui = false;
    await expect(demarrer(i, RETOUR)).rejects.toThrow('adresse_publiee_refusee');
    admis.oui = true;
  });
  it('en clair hors organisation de test : refusé avant tout échange', async () => {
    const n = idp.demandes();
    await expect(demarrer({ ...i, test: false }, RETOUR)).rejects.toThrow();
    expect(idp.demandes()).toBe(n);
  });
});
