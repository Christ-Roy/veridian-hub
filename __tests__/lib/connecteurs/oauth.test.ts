// @vitest-environment node
/** L'échange OAuth contre un VRAI service (jetable) : le témoin passe, chaque mensonge est refusé. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => ({ c: null as any }));
vi.mock('@/lib/connecteurs/registre', () => ({ connecteur: (k: string) => (k === 'essai' ? reg.c : null), CONNECTEURS: [] }));

import { CHEMIN_RETOUR_CONNECTEUR, COOKIE_CONNECTEUR, ouvrirTransaction, partir, renouveler, revoquer, terminer, TRANSACTION_CONNECTEUR_S } from '@/lib/connecteurs/oauth';

import { ouvrirService } from '../../../e2e/systeme-sso/lib/service-jetable';

const RETOUR = `https://hub.test${CHEMIN_RETOUR_CONNECTEUR}`;
const D = { fetchImpl: fetch as never, enClair: true };
let s: Awaited<ReturnType<typeof ouvrirService>>;
let clients: any[];
const db = { connecteurClient: { findUnique: async ({ where: { connecteur_retour: w } }: any) => clients.find((x) => x.connecteur === w.connecteur && x.retour === w.retour) ?? null, create: async ({ data }: any) => { clients.push({ secretChiffre: null, ...data }); } } } as never;
beforeAll(async () => { vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40)); s = await ouvrirService(); reg.c = { cle: 'essai', nom: 'Essai', texte: '', mcpUrl: s.mcpUrl }; });
afterAll(() => s.fermer());
beforeEach(() => { s.mentir(null); clients = []; });

async function aller() {
  const d = await partir(db, reg.c, 'U', RETOUR, D);
  const r = await fetch(d.url, { redirect: 'manual' });
  return { t: ouvrirTransaction(d.cookie)!, retour: new URL(r.headers.get('location')!), url: new URL(d.url), cookie: d.cookie };
}
const tout = async () => { const a = await aller(); return terminer(db, a.t, a.retour, RETOUR, D); };

describe('partir', () => {
  it('le client s\'enregistre UNE fois ; PKCE, state neuf, jeton demandé pour ce service seul', async () => {
    const avant = s.vu.enregistrements;
    const [a, b] = [await aller(), await aller()];
    expect([s.vu.enregistrements - avant, clients.length]).toEqual([1, 1]);
    const p = a.url.searchParams;
    expect([p.get('code_challenge_method'), p.get('resource'), p.get('redirect_uri')]).toEqual(['S256', s.mcpUrl, RETOUR]);
    expect([a.t.state === b.t.state, a.t.verifier === b.t.verifier, a.t.userId]).toEqual([false, false, 'U']);
  });
  it('un service qui exige un secret : il est chiffré', async () => {
    s.mentir('secret_exige');
    await aller();
    expect(clients[0].secretChiffre).toMatch(/^v1\./);
    s.mentir(null);
  });
  it('un service qui n\'enregistre pas : refus, rien n\'est gardé', async () => {
    s.mentir('sans_enregistrement');
    await expect(partir(db, reg.c, 'U', RETOUR, D)).rejects.toThrow('sans_enregistrement');
    expect(clients).toEqual([]);
  });
});
it('ouvrirTransaction : 10 min, ne se forge pas', async () => {
  const { cookie } = await aller();
  const plus = Date.now() + TRANSACTION_CONNECTEUR_S * 1000 + 1_000;
  expect([ouvrirTransaction(cookie)?.cle, ouvrirTransaction(cookie, plus), ouvrirTransaction(undefined), ouvrirTransaction(`${cookie.slice(0, -3)}AAA`)]).toEqual(['essai', null, null, null]);
  expect(COOKIE_CONNECTEUR).not.toBe('veridian-federation');
});
describe('terminer', () => {
  it('témoin : un jeton, un renouvellement, une échéance', async () => {
    const j = await tout();
    expect([j.acces.length > 10, j.refresh!.length > 10, j.expireLe! > new Date()]).toEqual([true, true, true]);
  });
  it('state d\'une autre demande, PKCE d\'un autre, code rejoué, service inconnu : refusés', async () => {
    s.mentir('state');
    await expect(tout()).rejects.toThrow();
    s.mentir(null);
    const a = await aller();
    await expect(terminer(db, { ...a.t, verifier: 'x'.repeat(43) }, a.retour, RETOUR, D)).rejects.toThrow();
    const b = await aller();
    await terminer(db, b.t, b.retour, RETOUR, D);
    await expect(terminer(db, b.t, b.retour, RETOUR, D)).rejects.toThrow();
    await expect(terminer(db, { ...b.t, cle: 'autre' }, b.retour, RETOUR, D)).rejects.toThrow('connecteur_inconnu');
  });
});
it('renouveler : un jeton neuf ; refusé, il le dit', async () => {
  const j = await tout();
  const k = await renouveler(db, reg.c, j.refresh!, RETOUR, D);
  expect(k.acces).not.toBe(j.acces);
  await expect(renouveler(db, reg.c, j.refresh!, RETOUR, D)).rejects.toMatchObject({ error: 'invalid_grant' });
});
it('revoquer : au mieux, jamais une erreur', async () => {
  const j = await tout();
  const n = s.vu.revocations;
  expect([await revoquer(db, reg.c, j.refresh!, RETOUR, D), s.vu.revocations - n]).toEqual([true, 1]);
  expect(await revoquer(db, { ...reg.c, mcpUrl: 'http://127.0.0.1:9/mcp' }, 'x', RETOUR, D)).toBe(false);
});
it('hors épreuve, rien ne part en clair ni vers nos réseaux', async () => {
  await expect(partir(db, reg.c, 'U', RETOUR)).rejects.toThrow();
});
