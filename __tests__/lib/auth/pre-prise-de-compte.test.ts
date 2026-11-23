/**
 * M2 (SSO-ORGANISATIONS.md, 23/11) : pré-prise de compte. L'attaquant pose ses accès sur le compte d'un futur client
 * avant toute preuve ; à la première preuve du vrai titulaire, il ne doit plus rien lui rester. Table `account`
 * en mémoire : on vérifie les lignes qui restent, pas la forme des appels.
 */
import { describe, expect, it } from 'vitest';

import { applyProviderEmailProof, prouverParMail, retirerLiensNonProuves } from '@/lib/auth/email-proof-provider';

type Ligne = { userId: string; provider: string; providerAccountId: string };
type Where = {
  userId: string;
  provider?: string | { not?: string; notIn?: string[] };
  NOT?: { provider: string; providerAccountId: string };
};

function base(lignes: Ligne[], emailVerified: Date | null = null) {
  const user = { id: 'u1', emailVerified, sessionsValidAfter: null as Date | null };
  const correspond = (l: Ligne, w: Where) => {
    if (l.userId !== w.userId) return false;
    const p = w.provider;
    if (typeof p === 'string' && l.provider !== p) return false;
    if (p && typeof p === 'object') {
      if (p.not !== undefined && l.provider === p.not) return false;
      if (p.notIn && p.notIn.includes(l.provider)) return false;
    }
    if (w.NOT && l.provider === w.NOT.provider && l.providerAccountId === w.NOT.providerAccountId) return false;
    return true;
  };
  return {
    user,
    lignes,
    prisma: {
      user: {
        findUnique: async () => ({ emailVerified: user.emailVerified }),
        update: async ({ data }: { data: Partial<typeof user> }) => Object.assign(user, data),
      },
      account: {
        deleteMany: async ({ where }: { where: Where }) => {
          const avant = lignes.length;
          for (let i = lignes.length - 1; i >= 0; i--) if (correspond(lignes[i], where)) lignes.splice(i, 1);
          return { count: avant - lignes.length };
        },
      },
    } as never,
  };
}

describe('M2 : à la première preuve, l\'attaquant perd tout', () => {
  it('compte Google non vérifié de l\'attaquant, la victime prouve avec SON Google : seul le lien de la victime reste', async () => {
    const b = base([
      { userId: 'u1', provider: 'google', providerAccountId: 'g-attaquant' },
      { userId: 'u1', provider: 'microsoft-entra-id', providerAccountId: 'oid-attaquant' },
      { userId: 'u1', provider: 'google', providerAccountId: 'g-victime' },
    ]);
    await applyProviderEmailProof(b.prisma, 'u1', 'google', { providerAccountId: 'g-victime', sessions: 'toujours' });
    expect(b.lignes).toEqual([{ userId: 'u1', provider: 'google', providerAccountId: 'g-victime' }]);
    expect(b.user.emailVerified).toBeInstanceOf(Date);
    expect(b.user.sessionsValidAfter).toBeInstanceOf(Date);
  });

  it('mot de passe posé par l\'attaquant : annulé à la preuve fournisseur', async () => {
    const b = base([
      { userId: 'u1', provider: 'credentials', providerAccountId: 'x@acme.fr' },
      { userId: 'u1', provider: 'google', providerAccountId: 'g-victime' },
    ]);
    await applyProviderEmailProof(b.prisma, 'u1', 'google', { providerAccountId: 'g-victime', sessions: 'toujours' });
    expect(b.lignes.map((l) => l.provider)).toEqual(['google']);
  });

  it('rien à retirer, preuve avant émission de session : les sessions d\'avant tombent quand même', async () => {
    const b = base([{ userId: 'u1', provider: 'google', providerAccountId: 'g-victime' }]);
    await applyProviderEmailProof(b.prisma, 'u1', 'google', { providerAccountId: 'g-victime', sessions: 'toujours' });
    expect(b.user.sessionsValidAfter).toBeInstanceOf(Date);
  });

  it('compte neuf, session déjà émise (event signIn) : rien à retirer, la session qui vient de naître reste', async () => {
    const b = base([{ userId: 'u1', provider: 'google', providerAccountId: 'g-victime' }]);
    await applyProviderEmailProof(b.prisma, 'u1', 'google', { providerAccountId: 'g-victime', sessions: 'si_retrait' });
    expect(b.user.sessionsValidAfter).toBeNull();
  });

  it('preuve par mail (lien, invitation) : tous les liens OAuth posés avant tombent, le mot de passe reste, sessions coupées', async () => {
    const b = base([
      { userId: 'u1', provider: 'credentials', providerAccountId: 'x@acme.fr' },
      { userId: 'u1', provider: 'microsoft-entra-id', providerAccountId: 'oid-attaquant' },
    ]);
    expect(await prouverParMail(b.prisma, 'u1')).toBe(1);
    expect(b.lignes.map((l) => l.provider)).toEqual(['credentials']);
    expect(b.user.sessionsValidAfter).toBeInstanceOf(Date);
  });

  it('adresse déjà prouvée : rien ne bouge (un lien prouvé plus tard n\'est jamais retiré)', async () => {
    const b = base([{ userId: 'u1', provider: 'microsoft-entra-id', providerAccountId: 'oid' }], new Date());
    expect(await prouverParMail(b.prisma, 'u1')).toBe(0);
    await applyProviderEmailProof(b.prisma, 'u1', 'google', { providerAccountId: 'g', sessions: 'toujours' });
    expect(b.lignes).toHaveLength(1);
  });

  it('sans désignation exacte (ancien appel) : tout le fournisseur est gardé, rétrocompatible', async () => {
    const b = base([
      { userId: 'u1', provider: 'google', providerAccountId: 'g1' },
      { userId: 'u1', provider: 'microsoft-entra-id', providerAccountId: 'o1' },
    ]);
    expect(await retirerLiensNonProuves(b.prisma as never, 'u1', 'google')).toBe(1);
  });
});
