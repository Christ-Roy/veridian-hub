// @vitest-environment node
/** Catalogue : à qui chaque app est ouverte, quels espaces, et ce que transporte une session d'app. */
import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { appsDe, espacesDe, sessionPour, type Db } from '@/lib/mcp/catalogue';

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.MCP_SIGNING_JWK = JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'k1' });
});
const QUI = { hubUserId: 'u', email: 'u@example.test', clientId: 'c', scope: 'veridian' };
const APP = { appKey: 'crm', label: 'CRM', mcpUrl: 'https://crm.test/mcp' };

describe('appsDe et espacesDe', () => {
  it('une app « tenant_app » n\'est ouverte que si elle est activée pour ce compte', async () => {
    const base = (actives: string[]) => ({
      mcpApp: { findMany: async () => [{ appKey: 'academy', label: 'Academy', mcpUrl: 'x', acces: 'tenant_app' }, { appKey: 'notifuse', label: 'Mail', mcpUrl: 'y', acces: 'tous' }] },
      tenantApp: { findMany: async () => actives.map((appKey) => ({ appKey })) },
    }) as unknown as Db;
    expect((await appsDe(base([]), 'u')).map((a) => a.appKey)).toEqual(['notifuse']);
    expect((await appsDe(base(['academy']), 'u')).map((a) => a.appKey)).toEqual(['academy', 'notifuse']);
  });

  it('un propriétaire aussi inscrit comme membre ne voit son espace qu\'une fois, en propriétaire', async () => {
    const t = { id: 't1', name: 'Un', slug: 'un' };
    const db = {
      tenant: { findMany: async ({ where }: { where: { userId?: string } }) => (where.userId ? [t] : []) },
      tenantMember: { findMany: async () => [{ tenantId: 't1', role: 'member' }] },
    } as unknown as Db;
    expect(await espacesDe(db, 'u')).toEqual([{ id: 't1', nom: 'Un', slug: 'un', role: 'proprietaire' }]);
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
  });
});
