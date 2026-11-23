/** Plafond par compte : indépendant de l'IP, ralentit, et un tiers ne ferme pas durablement la porte d'un client (23/11). */
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ECHECS_MAX, FENETRE_MS, lireAppareil, nomCookieAppareil, PlafondEchecs, signerAppareil, verifierMotDePasse } from '@/lib/auth/plafond-compte';

const SECRET = 'secret-de-test-au-moins-32-octets-xxxxxxxx';
const HASH = bcrypt.hashSync('bon-mot-de-passe', 4);
const VICTIME = 'client@exemple.fr';
let n = 0;
/** Chaque essai vient d'une IP différente. */
const essai = (p: PlafondEchecs, password: string, o: { email?: string; cookie?: string; hash?: string | null } = {}) =>
  verifierMotDePasse(
    { email: o.email ?? VICTIME, password, headers: new Headers({ 'x-forwarded-for': `198.51.100.${++n % 250}`, ...(o.cookie ? { cookie: o.cookie } : {}) }), lireHash: async () => (o.hash === undefined ? HASH : o.hash) },
    p,
  );
const cookie = (email: string, quand?: number) => `x=1; ${nomCookieAppareil()}=${signerAppareil(email, SECRET, quand)}`;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('DEPLOY_ENV', 'prod');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('plafond par compte', () => {
  it(`${ECHECS_MAX} échecs depuis ${ECHECS_MAX} adresses, puis ralenti, bon mot de passe compris`, async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX; i++) expect((await essai(p, 'faux')).etat).toBe('refuse');
    expect((await essai(p, 'faux')).etat).toBe('ralenti');
    expect((await essai(p, 'bon-mot-de-passe')).etat).toBe('ralenti');
    expect((await essai(p, 'faux', { email: 'autre@exemple.fr' })).etat, 'un autre compte n\'est pas touché').toBe('refuse');
  });

  it('même compte écrit autrement (casse, espaces) : même plafond', async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX; i++) await essai(p, 'faux', { email: ' Client@Exemple.FR ' });
    expect((await essai(p, 'faux')).etat).toBe('ralenti');
  });

  it('essais simultanés : pas plus de places que le plafond', async () => {
    const p = new PlafondEchecs();
    const r = await Promise.all(Array.from({ length: 40 }, () => essai(p, 'faux')));
    expect(r.filter((x) => x.etat === 'refuse')).toHaveLength(ECHECS_MAX);
  });

  it('les réussites ne comptent pas', async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX * 3; i++) expect((await essai(p, 'bon-mot-de-passe')).etat).toBe('ok');
    expect(p.size()).toBe(0);
  });

  it('un tiers qui insiste ne prolonge rien : la porte rouvre à l\'heure dite', () => {
    const p = new PlafondEchecs();
    const t0 = 1_000_000_000;
    for (let i = 0; i < ECHECS_MAX; i++) expect(p.reserver('c', t0 + i).ok).toBe(true);
    for (let t = t0 + 1000; t < t0 + FENETRE_MS; t += 1000) expect(p.reserver('c', t).ok).toBe(false);
    expect(p.reserver('c', t0 + FENETRE_MS + 1).ok).toBe(true);
  });

  it('le client entre depuis un navigateur connu pendant l\'attaque', async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX + 5; i++) await essai(p, 'faux');
    expect((await essai(p, 'bon-mot-de-passe', { cookie: cookie(VICTIME) })).etat).toBe('ok');
  });

  it('le couloir d\'un navigateur connu est borné lui aussi', async () => {
    const p = new PlafondEchecs();
    const c = cookie(VICTIME);
    for (let i = 0; i < ECHECS_MAX; i++) expect((await essai(p, 'faux', { cookie: c })).etat).toBe('refuse');
    expect((await essai(p, 'faux', { cookie: c })).etat).toBe('ralenti');
  });

  it('le cookie d\'un autre compte, expiré ou falsifié n\'ouvre aucun couloir', async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX; i++) await essai(p, 'faux');
    const vieux = cookie(VICTIME, Math.floor(Date.now() / 1000) - 181 * 24 * 3600);
    for (const c of [cookie('attaquant@exemple.fr'), vieux, `${cookie(VICTIME)}x`, `${nomCookieAppareil()}=a.b.c.d`]) {
      expect((await essai(p, 'bon-mot-de-passe', { cookie: c })).etat, c.slice(0, 30)).toBe('ralenti');
    }
    expect(lireAppareil(cookie(VICTIME), VICTIME, SECRET)).toBeTruthy();
    expect(lireAppareil(cookie(VICTIME), VICTIME, 'autre-secret')).toBeNull();
  });

  it('compte inexistant : plafonné pareil (la réponse ne dit pas s\'il existe)', async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX; i++) expect((await essai(p, 'x', { hash: null })).etat).toBe('refuse');
    expect((await essai(p, 'x', { hash: null })).etat).toBe('ralenti');
  });

  it('mémoire : les comptes froids sont oubliés', () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < 200; i++) p.reserver(`c${i}`, 1000);
    for (let i = 0; i < 300; i++) p.reserver('chaud', 1000 + FENETRE_MS * 2 + i);
    expect(p.size()).toBe(1);
  });

  it('le journal ne porte pas l\'adresse', async () => {
    const p = new PlafondEchecs();
    for (let i = 0; i < ECHECS_MAX + 1; i++) await essai(p, 'faux');
    expect(JSON.stringify((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('client@');
  });
});
