/**
 * Épreuve VER-270 (dérogation « deux instances ») : deux instances du Hub partagent les plafonds de débit, le budget d'appels
 * et le verrou « un programme à la fois », sur une vraie PostgreSQL.
 *
 * Deux instances = deux copies du graphe de modules (vi.resetModules), donc deux états mémoire distincts. Ce qui les relie,
 * c'est la base seule. Avec l'ancien code en mémoire, les deux copies accepteraient le double du plafond.
 *
 * Lancement : HUB_TEST_DATABASE_URL=<base jetable, schéma hub_app migré> npx vitest run __tests__/integration/compteurs-deux-instances.test.ts
 * Sans HUB_TEST_DATABASE_URL : la suite est SAUTÉE (état NON ABOUTI, pas un passage).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Vraies implémentations (les mocks mémoire de __tests__/setup.ts ne s'appliquent pas à cette épreuve).
vi.unmock('@/lib/auth/compteurs');
vi.unmock('@/lib/mcp/verrou-programme');

const URL_BASE = process.env.HUB_TEST_DATABASE_URL;
const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function instance() {
  vi.resetModules();
  const compteurs = await import('@/lib/auth/compteurs');
  const limites = await import('@/lib/auth/rate-limit');
  const programme = await import('@/lib/mcp/programme');
  const verrou = await import('@/lib/mcp/verrou-programme');
  // Chaque instance prend les backends PostgreSQL (le défaut des modules réels, rendu explicite ici).
  compteurs.installerMagasin(compteurs.magasinPrisma);
  verrou.installerVerrou(verrou.verrouPostgres);
  return { compteurs, limites, programme };
}

describe.skipIf(!URL_BASE)('deux instances, une base', () => {
  let a: Awaited<ReturnType<typeof instance>>;
  let b: Awaited<ReturnType<typeof instance>>;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_BASE;
    a = await instance();
    b = await instance();
  });

  afterAll(async () => {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: URL_BASE });
    await c.connect();
    await c.query("DELETE FROM hub_app.compteurs_fenetre WHERE cle LIKE '%' AND limiteur LIKE 'test-%'").catch(() => undefined);
    await c.end();
  });

  it('plafond de débit : 5 par minute, deux instances entrelacées, 5 acceptées au total', async () => {
    const limiteur = `test-plafond-${uniq}`;
    const ia = new a.limites.RateLimiter({ capacity: 5, windowMs: 60_000, name: limiteur });
    const ib = new b.limites.RateLimiter({ capacity: 5, windowMs: 60_000, name: limiteur });
    const t = Date.now();
    const resultats = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? ia : ib).enforce('1.2.3.4', t)));
    const acceptees = resultats.filter((r) => r.ok).length;
    expect(acceptees).toBe(5);
    const refusees = resultats.filter((r) => !r.ok);
    expect(refusees.length).toBe(7);
    for (const r of refusees) expect(r.ok === false && r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('panne de base : refus fermé, jamais un passage', async () => {
    const limiteur = `test-panne-${uniq}`;
    const { installerMagasin } = a.compteurs;
    const cassé = { incrementer: async () => { throw new Error('base muette'); }, lire: async () => { throw new Error('base muette'); }, vider: async () => undefined, menage: async () => undefined };
    installerMagasin(cassé);
    const l = new a.limites.RateLimiter({ capacity: 5, windowMs: 60_000, name: limiteur });
    const r = await l.enforce('x', Date.now());
    installerMagasin(a.compteurs.magasinPrisma);
    expect(r.ok).toBe(false);
  });

  it('un programme à la fois par compte : deux instances en même temps, un seul entre', async () => {
    const compte = `test-user-${uniq}`;
    const t = Date.now();
    const [pa, pb] = await Promise.all([a.programme.prendrePlace(compte, t), b.programme.prendrePlace(compte, t)]);
    expect([pa.ok, pb.ok].filter(Boolean).length).toBe(1);
    const gagnant = pa.ok ? pa : pb;
    if (!gagnant.ok) throw new Error('aucune place prise');
    // Rendue : une autre instance peut à nouveau prendre la place.
    await gagnant.rendre();
    const suivant = await b.programme.prendrePlace(compte, t);
    expect(suivant.ok).toBe(true);
    if (suivant.ok) await suivant.rendre();
  });

  it('une coupure libère le verrou : la connexion qui le tient disparaît, la place se reprend', async () => {
    const compte = `test-coupure-${uniq}`;
    const t = Date.now();
    const tenue = await a.programme.prendrePlace(compte, t);
    expect(tenue.ok).toBe(true);
    const absente = await b.programme.prendrePlace(compte, t);
    expect(absente.ok).toBe(false);
    // Simule la mort de l'instance : on coupe la connexion dédiée au verrou (application_name hub-programme).
    const { Client } = await import('pg');
    const admin = new Client({ connectionString: URL_BASE });
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'hub-programme' AND pid <> pg_backend_pid()");
    await admin.end();
    await new Promise((r) => setTimeout(r, 300));
    const reprise = await b.programme.prendrePlace(compte, t);
    expect(reprise.ok).toBe(true);
    if (reprise.ok) await reprise.rendre();
    if (tenue.ok) await tenue.rendre().catch(() => undefined);
  });

  it('budget d\'appels par minute partagé : 600 comptés par l\'instance A, l\'instance B refuse', async () => {
    const compte = `test-budget-${uniq}`;
    const t = Date.now();
    await Promise.all(Array.from({ length: 600 }, () => a.compteurs.compterFenetre('programme-appels', compte, 60_000, t)));
    const refus = await b.programme.prendrePlace(compte, t);
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.message).toMatch(/Trop d'appels/);
    // Le refus du budget rend le verrou : aucune place n'est restée prise.
    const autre = await a.programme.prendrePlace(`${compte}-autre`, t);
    expect(autre.ok).toBe(true);
    if (autre.ok) await autre.rendre();
  });
});

describe.skipIf(URL_BASE)('deux instances, une base (NON ABOUTI sans HUB_TEST_DATABASE_URL)', () => {
  it.skip('exige HUB_TEST_DATABASE_URL', () => undefined);
});
