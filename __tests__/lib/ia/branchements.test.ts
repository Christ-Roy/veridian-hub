import { beforeEach, describe, expect, it } from 'vitest';

import { activer, brancher, branchementsDe, cleEnClair, estActive, moteurActif, ouvrirSession, revoquer } from '@/lib/ia/branchements';

const env = { VAULT_ENC_KEY: 'k'.repeat(43) } as NodeJS.ProcessEnv;
const CLE = 'sk-ant-api03-ROBERT-0123456789abcdefghijklmnop';

/** Base en mémoire, juste assez de Prisma pour ces trois tables. */
function base() {
  const branchements: any[] = [];
  const activations: any[] = [];
  const sessions: any[] = [];
  let n = 0;
  const memeCle = (r: any, w: any) => Object.entries(w).every(([k, v]) => r[k] === v);
  return {
    branchements,
    sessions,
    iaBranchement: {
      upsert: async ({ where, create, update }: any) => {
        const w = where.hubUserId_fournisseur;
        const r = branchements.find((x) => memeCle(x, w));
        if (r) return Object.assign(r, update, { updatedAt: new Date() });
        const neuf = { id: `b${++n}`, ...create, createdAt: new Date(), updatedAt: new Date() };
        branchements.push(neuf);
        return neuf;
      },
      findMany: async ({ where }: any) => branchements.filter((x) => memeCle(x, where)),
      findFirst: async ({ where }: any) => branchements.filter((x) => memeCle(x, where)).at(-1) ?? null,
      deleteMany: async ({ where }: any) => {
        const avant = branchements.length;
        for (let i = branchements.length - 1; i >= 0; i--) if (memeCle(branchements[i], where)) branchements.splice(i, 1);
        return { count: avant - branchements.length };
      },
    },
    iaActivation: {
      upsert: async ({ where, create, update }: any) => {
        const r = activations.find((x) => memeCle(x, where.hubUserId_app_tenantId));
        if (r) return Object.assign(r, update);
        activations.push({ ...create });
        return create;
      },
      findUnique: async ({ where }: any) => activations.find((x) => memeCle(x, where.hubUserId_app_tenantId)) ?? null,
    },
    iaSession: {
      create: async ({ data }: any) => {
        const s = { id: `00000000-0000-4000-8000-00000000000${++n}`, ...data };
        sessions.push(s);
        return s;
      },
      findUnique: async ({ where }: any) => sessions.find((x) => x.id === where.id) ?? null,
      update: async ({ where }: any) => sessions.find((x) => x.id === where.id),
    },
  };
}

let db: ReturnType<typeof base>;
beforeEach(() => {
  db = base();
});

describe('branchement de l\'IA', () => {
  it('la clé est scellée en base et jamais rendue par la vue', async () => {
    const v = await brancher(db as never, 'robert', { fournisseur: 'anthropic', cle: CLE }, env);
    expect(v).toEqual(expect.objectContaining({ fournisseur: 'anthropic', cleFin: 'mnop' }));
    expect(JSON.stringify(v)).not.toContain(CLE);
    expect(JSON.stringify(await branchementsDe(db as never, 'robert'))).not.toContain(CLE);
    expect(JSON.stringify(db.branchements)).not.toContain(CLE);
    expect((await cleEnClair(db as never, 'robert', env))?.cle).toBe(CLE);
  });

  it('révoquer efface le branchement', async () => {
    await brancher(db as never, 'robert', { fournisseur: 'anthropic', cle: CLE }, env);
    expect(await revoquer(db as never, 'robert', 'anthropic')).toBe(true);
    expect(await cleEnClair(db as never, 'robert', env)).toBeNull();
  });

  it('une clé vide ou à espaces est refusée', async () => {
    await expect(brancher(db as never, 'robert', { fournisseur: 'openai', cle: 'court' }, env)).rejects.toThrow('cle_invalide');
    await expect(brancher(db as never, 'robert', { fournisseur: 'openai', cle: 'sk-avec espace-0123456789' }, env)).rejects.toThrow('cle_invalide');
  });
});

describe('interrupteur : allumé d\'office, retrait volontaire (Robert, 23/11 : SSO-like)', () => {
  it('sans ligne, allumé ; un retrait n\'éteint que cette app et cet espace ; rallumer rétablit', async () => {
    const t = { hubUserId: 'robert', app: 'academy', tenantId: 't1' };
    expect(await estActive(db as never, t)).toBe(true);
    expect(await estActive(db as never, { ...t, app: 'crm' })).toBe(true);
    await activer(db as never, t, false);
    expect(await estActive(db as never, t)).toBe(false);
    expect(await estActive(db as never, { ...t, tenantId: 't2' })).toBe(true);
    expect(await estActive(db as never, { ...t, app: 'crm' })).toBe(true);
    await activer(db as never, t, true);
    expect(await estActive(db as never, t)).toBe(true);
  });
});

describe('menace 7 : reprise de session', () => {
  const robert = { hubUserId: 'robert', app: 'academy', tenantId: 't1' };

  it('le Hub crée l\'identifiant ; son propriétaire le reprend', async () => {
    const s = await ouvrirSession(db as never, robert, 'cle-api');
    expect(s?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ouvrirSession(db as never, robert, 'cle-api', s!.id)).toEqual({ id: s!.id });
  });

  it('la session d\'un autre client, d\'un autre tenant, d\'une autre app ou d\'un autre moteur est refusée', async () => {
    const s = await ouvrirSession(db as never, robert, 'cle-api');
    expect(await ouvrirSession(db as never, { ...robert, hubUserId: 'intrus' }, 'cle-api', s!.id)).toBeNull();
    expect(await ouvrirSession(db as never, { ...robert, tenantId: 't2' }, 'cle-api', s!.id)).toBeNull();
    expect(await ouvrirSession(db as never, { ...robert, app: 'crm' }, 'cle-api', s!.id)).toBeNull();
    expect(await ouvrirSession(db as never, robert, 'claude-code-abonnement', s!.id)).toBeNull();
  });

  it('un identifiant inventé est refusé, jamais créé sous ce nom', async () => {
    const invente = '11111111-1111-4111-8111-111111111111';
    expect(await ouvrirSession(db as never, robert, 'cle-api', invente)).toBeNull();
    expect(db.sessions.find((x) => x.id === invente)).toBeUndefined();
  });
});

describe('moteur actif', () => {
  it('l\'abonnement passe devant une clé branchée après lui ; sans abonnement, la clé', async () => {
    expect(await moteurActif(db as never, 'hub-robert')).toBeNull();
    await brancher(db as never, 'hub-robert', { fournisseur: 'anthropic', cle: CLE }, env);
    expect(await moteurActif(db as never, 'hub-robert')).toBe('cle-api');
    await db.iaBranchement.upsert({
      where: { hubUserId_fournisseur: { hubUserId: 'hub-robert', fournisseur: 'claude-abonnement' } },
      create: { hubUserId: 'hub-robert', fournisseur: 'claude-abonnement', moteur: 'claude-code-abonnement', modele: 'max', cleScellee: '', cleEmpreinte: '', cleFin: '' },
      update: {},
    });
    // La clé est rangée de nouveau après l'abonnement (hub ia brancher) : l'abonnement reste le moteur.
    await brancher(db as never, 'hub-robert', { fournisseur: 'openrouter', cle: CLE.replace('ant', 'or') }, env);
    expect(await moteurActif(db as never, 'hub-robert')).toBe('claude-code-abonnement');
  });
});
