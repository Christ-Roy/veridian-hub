/** Base en mémoire pour les tests de la porte MCP : seulement les opérations que lib/mcp utilise. */
import { randomUUID } from 'node:crypto';

type Ligne = Record<string, any>;

function correspond(l: Ligne, where: Ligne = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('gt' in v) return l[k] > v.gt;
      if ('in' in v) return v.in.includes(l[k]);
      if ('not' in v) return l[k] !== v.not;
    }
    if (v === null) return l[k] === null || l[k] === undefined;
    return l[k] === v;
  });
}

function table(cle: string, defauts: () => Ligne = () => ({})) {
  const lignes: Ligne[] = [];
  return {
    lignes,
    async create({ data }: { data: Ligne }) {
      const l = { createdAt: new Date(), ...defauts(), ...data };
      if (lignes.some((x) => x[cle] === l[cle])) throw new Error(`doublon ${cle}`);
      lignes.push(l);
      return l;
    },
    async findUnique({ where }: { where: Ligne }) {
      return lignes.find((l) => correspond(l, where)) ?? null;
    },
    async findFirst({ where, orderBy }: { where: Ligne; orderBy?: Ligne }) {
      const t = lignes.filter((l) => correspond(l, where));
      if (orderBy?.createdAt === 'asc') t.sort((a, b) => a.createdAt - b.createdAt);
      return t[0] ?? null;
    },
    async findMany({ where }: { where?: Ligne } = {}) {
      return lignes.filter((l) => correspond(l, where));
    },
    async updateMany({ where, data }: { where: Ligne; data: Ligne }) {
      const t = lignes.filter((l) => correspond(l, where));
      t.forEach((l) => Object.assign(l, data));
      return { count: t.length };
    },
    async update({ where, data }: { where: Ligne; data: Ligne }) {
      const l = lignes.find((x) => correspond(x, where));
      if (!l) throw new Error('absent');
      return Object.assign(l, data);
    },
    async upsert({ where, create, update }: { where: Ligne; create: Ligne; update: Ligne }) {
      const l = lignes.find((x) => correspond(x, where));
      return l ? Object.assign(l, update) : this.create({ data: create });
    },
    async deleteMany({ where }: { where: Ligne }) {
      const avant = lignes.length;
      for (let i = lignes.length - 1; i >= 0; i--) if (correspond(lignes[i], where)) lignes.splice(i, 1);
      return { count: avant - lignes.length };
    },
  };
}

export function fausseBase() {
  return {
    oauthClient: table('clientId', () => ({ id: randomUUID(), lastUsedAt: null })),
    oauthCode: table('codeHash', () => ({ usedAt: null })),
    oauthToken: table('tokenHash', () => ({ id: randomUUID(), usedAt: null, revokedAt: null })),
    user: table('id', () => ({ sessionsValidAfter: null })),
    mcpApp: table('appKey', () => ({ enabled: true, acces: 'tenant_app' })),
    tenantApp: table('id', () => ({ id: randomUUID(), enabled: true })),
    tenant: table('id', () => ({ deletedAt: null })),
    tenantTrial: table('tenantId'),
    auditLog: table('id', () => ({ id: randomUUID() })),
  };
}

export type FausseBase = ReturnType<typeof fausseBase>;
