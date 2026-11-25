// @vitest-environment node
/** La porte MCP contre un VRAI service (jetable) : ses outils, avec le jeton de la personne, et rien d'autre de chez nous. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => ({ l: [] as any[] }));
vi.mock('@/lib/connecteurs/registre', () => ({ CONNECTEURS: reg.l, connecteur: (k: string) => reg.l.find((c) => c.cle === k) ?? null }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async () => {} }));
vi.mock('@/utils/helpers', () => ({ getURL: (p: string) => `https://hub.test${p}` }));

import { garder } from '@/lib/connecteurs/coffre';
import { ouvrirTransaction, partir, terminer } from '@/lib/connecteurs/oauth';
import { retourConnecteur, servicesDe, sessionExterne } from '@/lib/connecteurs/porte';
import { catalogue } from '@/lib/mcp/catalogue';
import { viderCache } from '@/lib/mcp/cache';

import { ouvrirService } from '../../../e2e/systeme-sso/lib/service-jetable';

const D = { fetchImpl: fetch as never, enClair: true };
let s: Awaited<ReturnType<typeof ouvrirService>>;
let l: any[];
let clients: any[];
const ok = (x: any, w: any) => Object.entries(w).every(([k, v]) => x[k] === v);
const db = {
  connecteurClient: { findUnique: async ({ where: { connecteur_retour: w } }: any) => clients.find((x) => ok(x, w)) ?? null, create: async ({ data }: any) => { clients.push({ secretChiffre: null, ...data }); } },
  connexionExterne: {
    findMany: async ({ where }: any) => l.filter((x) => ok(x, where)),
    findUnique: async ({ where }: any) => { const x = l.find((y) => (where.id ? y.id === where.id : ok(y, where.hubUserId_connecteur))); return x ? { ...x } : null; },
    upsert: async ({ create }: any) => { l = [{ id: 'c', ...create }]; },
    updateMany: async ({ where, data }: any) => { const r = l.filter((x) => ok(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
  },
  mcpApp: { findMany: async () => [] },
} as never;
beforeAll(async () => { vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40)); vi.spyOn(console, 'error').mockReturnValue(); s = await ouvrirService(); reg.l.push({ cle: 'essai', nom: 'Essai', texte: '', mcpUrl: s.mcpUrl }); });
afterAll(() => s.fermer());
beforeEach(async () => {
  s.mentir(null);
  viderCache();
  l = [];
  clients = [];
  const d = await partir(db, reg.l[0], 'U', retourConnecteur(), D);
  const retour = new URL((await fetch(d.url, { redirect: 'manual' })).headers.get('location')!);
  await garder(db, 'h', 'essai', await terminer(db, ouvrirTransaction(d.cookie)!, retour, retourConnecteur(), D));
});

it('retourConnecteur : une seule adresse, la nôtre', () => expect(retourConnecteur()).toBe('https://hub.test/api/connecteurs/retour'));
it('servicesDe : les siens, actifs', async () => {
  expect((await servicesDe(db, 'h')).map((x) => [x.appKey, x.externe])).toEqual([['essai', true]]);
  expect(await servicesDe(db, 'autre')).toEqual([]);
  l[0].etat = 'a_rebrancher';
  expect(await servicesDe(db, 'h')).toEqual([]);
});
describe('sessionExterne', () => {
  it('ses outils, joués avec SON jeton ; aucune identité du Hub ne part', async () => {
    const x = await sessionExterne(db, 'h', 'essai', D);
    expect((await x.outils()).map((o) => o.name)).toEqual(['chercher']);
    expect(JSON.stringify(await x.appeler('chercher', { q: 'devis' }))).toContain('trouvé');
    expect(Object.keys(s.vu.entetes).filter((k) => /veridian|hub/i.test(k))).toEqual([]);
  });
  it('jeton refusé : un renouvellement, puis ça marche', async () => {
    s.perimer();
    const n = s.vu.renouvellements;
    await (await sessionExterne(db, 'h', 'essai', D)).outils();
    expect(s.vu.renouvellements - n).toBe(1);
  });
  it('refusé pour de bon : dit « à rebrancher », sans boucle', async () => {
    s.perimer();
    s.mentir('refresh_refuse');
    const n = s.vu.renouvellements;
    await expect(sessionExterne(db, 'h', 'essai', D)).rejects.toThrow('à rebrancher');
    expect([s.vu.renouvellements - n, l[0].etat]).toEqual([1, 'a_rebrancher']);
  });
  it('service en panne : dit, et rien n\'est débranché', async () => {
    s.perimer();
    s.mentir('panne');
    await expect(sessionExterne(db, 'h', 'essai', D)).rejects.toThrow('ne répond pas');
    expect(l[0].etat).toBe('active');
  });
  it('jeton toujours refusé malgré un neuf : une erreur, deux essais au plus', async () => {
    s.mentir('jeton_refuse');
    const n = s.vu.jetonsVus.length;
    await expect(sessionExterne(db, 'h', 'essai', D)).rejects.toThrow();
    expect(s.vu.jetonsVus.length - n).toBe(2);
  });
  it('celui d\'une autre personne, ou inconnu : jamais', async () => {
    await expect(sessionExterne(db, 'autre', 'essai', D)).rejects.toThrow('à rebrancher');
    await expect(sessionExterne(db, 'h', 'autre', D)).rejects.toThrow('inconnu');
  });
});
it('le catalogue de la porte : un service muet n\'emporte pas les autres apps', async () => {
  const qui = { hubUserId: 'h', email: 'a@x.fr', name: 'A', clientId: 'c', clientName: null, scope: '' } as never;
  const c = await catalogue(db, qui, [{ nom: 'hub.mon_compte', app: 'hub', description: '', inputSchema: {}, local: 'mon_compte' }]);
  expect([c.apps.map((a) => a.appKey), c.outils.map((o) => o.nom), c.injoignables.map((x) => x.app)]).toEqual([['essai'], ['hub.mon_compte'], ['essai']]);
});
