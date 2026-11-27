// @vitest-environment node
/** L'échange OAuth contre un VRAI service (jetable) : le témoin passe, chaque mensonge est refusé. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => ({ c: null as any }));
vi.mock('@/lib/connecteurs/registre', () => ({ connecteur: (k: string) => (k === 'essai' ? reg.c : null), CONNECTEURS: [] }));

import { CHEMIN_RETOUR_CONNECTEUR, COOKIE_CONNECTEUR, desinscrire, inscrireEtSonder, ouvrirTransaction, partir, renouveler, revoquer, terminer, TRANSACTION_CONNECTEUR_S } from '@/lib/connecteurs/oauth';

import { fausseBaseConnexions } from './fausse-base';
import { ouvrirService } from '../../../e2e/systeme-sso/lib/service-jetable';

const RETOUR = `https://hub.test${CHEMIN_RETOUR_CONNECTEUR}`;
const D = { fetchImpl: fetch as never, enClair: true };
let s: Awaited<ReturnType<typeof ouvrirService>>;
const base = fausseBaseConnexions();
const db = base as never;
const clients = () => base.connecteurClient.lignes;
beforeAll(async () => { vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40)); s = await ouvrirService(); reg.c = { cle: 'essai', nom: 'Essai', texte: '', mcpUrl: s.mcpUrl, oauth: s.hotes, outils: {} }; });
afterAll(() => s.fermer());
beforeEach(() => { s.mentir(null); base.connecteurClient.vider(); vi.spyOn(console, 'error').mockReturnValue(); });

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
    expect([s.vu.enregistrements - avant, clients().length]).toEqual([1, 1]);
    const p = a.url.searchParams;
    expect([p.get('code_challenge_method'), p.get('resource'), p.get('redirect_uri')]).toEqual(['S256', s.mcpUrl, RETOUR]);
    expect([a.t.state === b.t.state, a.t.verifier === b.t.verifier, a.t.userId]).toEqual([false, false, 'U']);
  });
  it('un service qui exige un secret : il est chiffré', async () => {
    s.mentir('secret_exige');
    await aller();
    expect(clients()[0].secretChiffre).toMatch(/^v1\./);
    s.mentir(null);
  });
  it('un service qui n\'enregistre pas : refus, rien n\'est gardé', async () => {
    s.mentir('sans_enregistrement');
    await expect(partir(db, reg.c, 'U', RETOUR, D)).rejects.toThrow('sans_enregistrement');
    expect(clients()).toEqual([]);
  });
});
describe('inscrireEtSonder (27/11)', () => {
  it('inscrit UNE fois, relit le client, et le départ va jusqu\'au bout : accepté ; rejoué : rien de neuf chez lui', async () => {
    const avant = s.vu.enregistrements;
    const a = await inscrireEtSonder(db, reg.c, RETOUR, D);
    expect([a.ecran, a.inscrit, Boolean(a.client_id), s.vu.enregistrements - avant, clients().length]).toEqual(['accepte', true, true, 1, 1]);
    const b = await inscrireEtSonder(db, reg.c, RETOUR, D);
    expect([b.ecran, b.inscrit, b.client_id, s.vu.enregistrements - avant]).toEqual(['accepte', false, a.client_id, 1]);
  });
  it('inscription acceptée puis retour refusé (Canva) : refus, avec la raison du service', async () => {
    s.mentir('retour_refuse');
    const r = await inscrireEtSonder(db, reg.c, RETOUR, D);
    expect([r.ecran, r.detail.startsWith('invalid_redirect_uri')]).toEqual(['refus', true]);
  });
});

describe('client préinscrit (Google, 27/11)', () => {
  const avec = (extra: object) => { const garde = reg.c; reg.c = { ...garde, preinscrit: { id: 'PRE_ID', secret: 'PRE_SECRET' }, depart: { access_type: 'offline' }, ...extra }; return () => { reg.c = garde; }; };
  it('le client vient du coffre : aucune inscription, rien en base ; le code s\'échange ; on ne l\'efface jamais', async () => {
    const remettre = avec({});
    try {
      s.preinscrire('pre-1', 'sec-1', [RETOUR]);
      // Rendues en toJSON par le job : entre guillemets, elles se lisent pareil.
      vi.stubEnv('PRE_ID', '"pre-1"'); vi.stubEnv('PRE_SECRET', '"sec-1"');
      const avant = s.vu.enregistrements;
      const a = await aller();
      expect([a.url.searchParams.get('client_id'), a.url.searchParams.get('access_type'), s.vu.enregistrements - avant, clients().length]).toEqual(['pre-1', 'offline', 0, 0]);
      expect((await terminer(db, a.t, a.retour, RETOUR, D)).acces).toBeTruthy();
      expect(await desinscrire(db, reg.c, RETOUR, D)).toBe('sans_jeton');
    } finally { remettre(); vi.unstubAllEnvs(); vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40)); }
  });
  it('variables absentes : pas branchable, et JAMAIS une inscription automatique à la place', async () => {
    const remettre = avec({});
    try {
      const avant = s.vu.enregistrements;
      await expect(partir(db, reg.c, 'U', RETOUR, D)).rejects.toThrow('non_inscrit');
      expect([s.vu.enregistrements - avant, clients().length]).toEqual([0, 0]);
    } finally { remettre(); }
  });
  it('un paramètre du service n\'écrase jamais state, PKCE ni le retour', async () => {
    const remettre = avec({ depart: { state: 'force', code_challenge: 'force', redirect_uri: 'https://ailleurs.test/x' } });
    try {
      s.preinscrire('pre-2', 'sec-2', [RETOUR]);
      vi.stubEnv('PRE_ID', 'pre-2'); vi.stubEnv('PRE_SECRET', 'sec-2');
      const p = (await aller()).url.searchParams;
      expect([p.get('state') === 'force', p.get('code_challenge') === 'force', p.get('redirect_uri')]).toEqual([false, false, RETOUR]);
    } finally { remettre(); vi.unstubAllEnvs(); vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40)); }
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
describe('revoquer', () => {
  it('chaque jeton ; vrai seulement si tous sont acceptés', async () => {
    const j = await tout();
    expect([await revoquer(db, reg.c, [j.refresh!, j.acces], RETOUR, D), s.vu.revoques.slice(-2), s.vivants().acces.includes(j.acces)]).toEqual([true, [j.refresh, j.acces], false]);
  });
  it.each(['revocation_refusee', 'sans_revocation', 'revocation_ailleurs', 'panne'] as const)('%s : jamais dit révoqué, jamais une erreur', async (x) => {
    const j = await tout();
    s.mentir(x === 'panne' ? 'redirige' : x);
    expect(await revoquer(db, reg.c, [j.refresh!], RETOUR, D)).toBe(false);
  });
  it('rien à révoquer, ou jamais inscrit : faux, et couper n\'inscrit personne', async () => {
    await tout();
    expect(await revoquer(db, reg.c, [], RETOUR, D)).toBe(false);
    base.connecteurClient.vider();
    const n = s.vu.enregistrements;
    expect([await revoquer(db, reg.c, ['x'], RETOUR, D), s.vu.enregistrements - n]).toEqual([false, 0]);
    await expect(renouveler(db, reg.c, 'x', RETOUR, D)).rejects.toThrow('non_inscrit');
    await expect(terminer(db, (await aller()).t, new URL(RETOUR), 'https://hub.test/autre', D)).rejects.toThrow('non_inscrit');
    expect(s.vu.enregistrements - n, 'seul le départ inscrit').toBe(1);
  });
});
describe('hôtes figés', () => {
  it.each(['autorisation_ailleurs', 'jeton_ailleurs', 'enregistrement_ailleurs', 'revocation_ailleurs'] as const)('%s : refusé avant tout envoi, rien n\'est inscrit', async (x) => {
    const n = s.vu.enregistrements;
    s.mentir(x);
    await expect(partir(db, reg.c, 'U', RETOUR, D)).rejects.toThrow('hote_inattendu');
    expect([s.vu.enregistrements - n, clients()]).toEqual([0, []]);
  });
  it('déjà inscrits, puis le service déplace son adresse de jeton : l\'échange et le renouvellement sont refusés', async () => {
    const a = await aller();
    s.mentir('jeton_ailleurs');
    await expect(terminer(db, a.t, a.retour, RETOUR, D)).rejects.toThrow('hote_inattendu');
    await expect(renouveler(db, reg.c, 'x', RETOUR, D)).rejects.toThrow('hote_inattendu');
  });
  it('l\'émetteur est le nôtre : ce que la ressource désigne n\'est pas lu', async () => {
    await expect(partir(db, { ...reg.c, oauth: { ...s.hotes, emetteur: 'http://127.0.0.1:9' } }, 'U', RETOUR, D)).rejects.toThrow();
  });
});
describe('notre inscription', () => {
  it('deux départs ensemble : une seule', async () => {
    const n = s.vu.enregistrements;
    await Promise.all([partir(db, reg.c, 'U', RETOUR, D), partir(db, reg.c, 'V', RETOUR, D)]);
    expect([s.vu.enregistrements - n, clients().length]).toEqual([1, 1]);
  });
  it('le jeton de gestion est gardé chiffré, jamais en clair', async () => {
    await aller();
    expect([clients()[0].gestionChiffre.startsWith('v1.'), clients()[0].gestionChiffre.includes('register')]).toEqual([true, false]);
  });
  it('l\'autre version nous a inscrits entre-temps : la nôtre est effacée chez lui, la sienne sert', async () => {
    const vraie = base.connecteurClient.create;
    const [n, e] = [s.vivants().clients, s.vu.effacements];
    vi.spyOn(base.connecteurClient, 'create').mockImplementationOnce(async (a: any) => {
      const r = (await (await fetch(`${s.base}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [RETOUR], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string };
      await vraie({ data: { connecteur: 'essai', retour: RETOUR, clientId: r.client_id } });
      return vraie(a);
    });
    await tout();
    expect([s.vivants().clients - n, s.vu.effacements - e, clients().length]).toEqual([1, 1, 1]);
  });
  it('desinscrire : effacée chez lui, puis chez nous', async () => {
    await aller();
    const n = s.vivants().clients;
    expect([await desinscrire(db, reg.c, RETOUR, D), s.vivants().clients - n, clients().length, await desinscrire(db, reg.c, RETOUR, D)]).toEqual(['effacee', -1, 0, 'absente']);
  });
  it('pas confirmée : gardée chez nous ; sans jeton de gestion : dit', async () => {
    await aller();
    s.mentir('redirige');
    expect([await desinscrire(db, reg.c, RETOUR, D), clients().length]).toEqual(['echec', 1]);
    s.mentir('sans_gestion');
    base.connecteurClient.vider();
    await aller();
    expect([clients()[0].gestionChiffre, await desinscrire(db, reg.c, RETOUR, D)]).toEqual([null, 'sans_jeton']);
  });
  it('une adresse de gestion ailleurs : ni elle ni son jeton ne sont gardés', async () => {
    s.mentir('gestion_ailleurs');
    await aller();
    expect(clients()[0].gestionChiffre).toBeNull();
  });
});
it('le nom du compte, quand le service le dit : nettoyé ; sinon rien', async () => {
  expect((await tout()).compte).toBeNull();
  s.nommer(' ACME\u202e\n SARL ');
  expect((await tout()).compte).toBe('ACME SARL');
  s.nommer(null);
});
it('hors épreuve, rien ne part en clair ni vers nos réseaux', async () => {
  await expect(partir(db, reg.c, 'U', RETOUR)).rejects.toThrow();
});
