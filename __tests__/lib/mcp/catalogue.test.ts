// @vitest-environment node
/** Catalogue : à qui chaque app est ouverte, quels espaces, et ce que transporte une session d'app. */
import { LIBRE } from '../federation/libre';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { appsDe, catalogue, espacesDe, sessionPour, tousEspaces, viderCache, type Db } from '@/lib/mcp/catalogue';

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.MCP_SIGNING_JWK = JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'k1' });
});
const QUI = { hubUserId: 'u', email: 'u@example.test', clientId: 'c', scope: 'veridian', preuve: { par: 'jeton', orgs: [] } };
const APP = { appKey: 'crm', label: 'CRM', mcpUrl: 'https://crm.test/mcp' };

describe('appsDe et espacesDe', () => {
  it('une app « tenant_app » n\'est ouverte que si elle est activée pour ce compte', async () => {
    const base = (actives: string[]) => ({
      ...LIBRE,
      mcpApp: { findMany: async () => [{ appKey: 'academy', label: 'Academy', mcpUrl: 'x', acces: 'tenant_app' }, { appKey: 'notifuse', label: 'Mail', mcpUrl: 'y', acces: 'tous' }] },
      tenantApp: { findMany: async () => actives.map((appKey) => ({ appKey })) },
    }) as unknown as Db;
    expect((await appsDe(base([]), 'u', { par: 'personne' })).map((a) => a.appKey)).toEqual(['notifuse']);
    expect((await appsDe(base(['academy']), 'u', { par: 'personne' })).map((a) => a.appKey)).toEqual(['academy', 'notifuse']);
  });

  it('le CRM coché par une organisation s\'ouvre à son membre vivant ; retiré, il se referme ; Academy non', async () => {
    const base = (membre: boolean) => ({
      ...LIBRE,
      mcpApp: { findMany: async () => ['academy', 'twenty'].map((appKey) => ({ appKey, label: appKey, mcpUrl: 'x', acces: 'tenant_app' })) },
      tenantApp: { findMany: async () => [] },
      tenantMember: { findMany: async () => (membre ? [{ tenantId: 'T' }] : []) },
      tenant: { findMany: async ({ where }: { where: { OR: { id?: { in: string[] } }[] } }) => where.OR.flatMap((o) => o.id?.in ?? []).map((id) => ({ id })) },
      organisation: { findMany: async ({ where }: { where: { tenantId: { in: string[] } } }) => where.tenantId.in.map(() => ({ modules: ['crm', 'academy'] })) },
    }) as unknown as Db;
    expect((await appsDe(base(true), 'u', { par: 'personne' })).map((a) => a.appKey)).toEqual(['twenty']);
    expect(await appsDe(base(false), 'u', { par: 'personne' })).toEqual([]);
  });

  it('un propriétaire aussi inscrit comme membre ne voit son espace qu\'une fois, en propriétaire', async () => {
    const t = { id: 't1', name: 'Un', slug: 'un', status: 'active' };
    const db = {
      ...LIBRE,
      tenant: { findMany: async ({ where }: { where: { userId?: string } }) => (where.userId ? [t] : []) },
      tenantMember: { findMany: async () => [{ tenantId: 't1', role: 'member' }] },
    } as unknown as Db;
    expect(await espacesDe(db, 'u', { par: 'personne' })).toEqual([{ id: 't1', nom: 'Un', slug: 'un', role: 'proprietaire' }]);
  });
});

describe('tousEspaces', () => {
  it('un suspendu se dit à part ; un membre retiré, un tenant supprimé : nulle part', async () => {
    const tenants = [{ id: 'a', name: 'A', slug: 'a', status: 'active' }, { id: 'p', name: 'P', slug: 'p', status: 'pending' }, { id: 's', name: 'S', slug: 's', status: 'suspended' }, { id: 'd', name: 'D', slug: 'd', status: 'deleted' }];
    const db = { ...LIBRE, tenant: { findMany: async ({ where }: { where: { userId?: string } }) => (where.userId ? tenants : []) }, tenantMember: { findMany: async ({ where }: { where: { deletedAt: null } }) => { expect(where.deletedAt).toBeNull(); return []; } } } as unknown as Db;
    const r = await tousEspaces(db, 'u', { par: 'personne' });
    expect(r.vivants.map((e) => e.id)).toEqual(['a', 'p']);
    expect(r.suspendus.map((e) => e.id)).toEqual(['s']);
    expect(r.vivants[0]).not.toHaveProperty('status');
    expect((await espacesDe(db, 'u', { par: 'personne' })).map((e) => e.id)).toEqual(['a', 'p']);
  });
});

describe('sessionPour', () => {
  const envois = async (deps: Parameters<typeof sessionPour>[2]) => {
    const entetes: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_u: string, i: RequestInit) => {
      entetes.push(i.headers as Record<string, string>);
      return Response.json({ jsonrpc: '2.0', id: (JSON.parse(String(i.body)) as { id?: number }).id, result: {} });
    }) as unknown as typeof fetch;
    await sessionPour(APP, QUI, { ...deps, fetchImpl }, 't1');
    return entetes;
  };

  it('les options de session vont jusqu\'à l\'app ; sans elles, rien n\'est annoncé', async () => {
    for (const h of await envois({ session: { entetes: { 'X-Veridian-MCP-Appel': 'programme' } } })) expect(h['X-Veridian-MCP-Appel']).toBe('programme');
    for (const h of await envois({})) expect(h).not.toHaveProperty('X-Veridian-MCP-Appel');
  });

  it('le jeton vise cette app, cet utilisateur, cet espace', async () => {
    const [h] = await envois({});
    const p = JSON.parse(Buffer.from(h.Authorization.split('.')[1], 'base64url').toString());
    expect(p).toMatchObject({ aud: APP.mcpUrl, sub: 'u', tenant_id: 't1' });
    expect(p).not.toHaveProperty('act');
    expect(p).not.toHaveProperty('org_role');
    const [r] = await envois({ orgRole: 'owner' });
    expect(JSON.parse(Buffer.from(r.Authorization.split('.')[1], 'base64url').toString()).org_role).toBe('owner');
  });
});

describe('catalogue et services extérieurs', () => {
  beforeEach(() => { vi.stubEnv('CONNECTEURS_OUVERTS', '1'); });
  it('reliés par la personne, ils sont dans ses apps ; à rebrancher, dits ; une lecture ratée n\'emporte rien', async () => {
    viderCache();
    const base = { ...LIBRE, mcpApp: { findMany: async () => [] }, tenantApp: { findMany: async () => [] }, tenantMember: { findMany: async () => [] }, tenant: { findMany: async () => [{ id: 't', name: 'E', slug: 'e', status: 'active' }] } };
    const SIENNE = { ...QUI, services: true };
    const avec = { ...base, connexionExterne: { findMany: async () => [{ connecteur: 'notion' }], findUnique: async () => null } } as unknown as Db;
    const c = await catalogue(avec, SIENNE as never, []);
    expect((await catalogue(avec, QUI as never, [])).apps, 'connexion IA sans services').toEqual([]);
    expect([c.apps.map((a) => [a.appKey, a.externe]), c.injoignables[0]?.raison]).toEqual([[['notion', true]], expect.stringContaining('à rebrancher')]);
    vi.spyOn(console, 'error').mockReturnValue();
    const casse = { ...base, connexionExterne: { findMany: async () => { throw new Error('base'); } } } as unknown as Db;
    expect((await catalogue(casse, SIENNE as never, [])).apps).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('catalogue', () => {
  it('les outils du Hub qu\'on lui passe, et eux seuls ; une app muette est dite injoignable, elle ne vide pas la liste', async () => {
    viderCache();
    const db = { ...LIBRE, mcpApp: { findMany: async () => [{ ...APP, acces: 'tous' }] }, tenantApp: { findMany: async () => [] } } as unknown as Db;
    const hub = { nom: 'hub.un', app: 'hub', local: 'un', description: '', inputSchema: {} };
    const muette = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    const c = await catalogue(db, QUI as never, [hub], { fetchImpl: muette, provisionneurs: {}, programme: true });
    expect(c.outils.map((o) => o.nom)).toEqual(['hub.un']);
    expect(c.injoignables.map((i) => i.app)).toEqual(['crm']);
  });
});
