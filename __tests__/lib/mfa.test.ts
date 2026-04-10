// Tests unitaires pour lib/mfa
// On mocke Prisma + l'email pour tester la logique pure sans DB ni réseau.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock module @/lib/prisma avant l'import de la lib sous test
vi.mock('@/lib/prisma', () => {
  const mfaCodes: any[] = [];
  return {
    prisma: {
      __state: { mfaCodes },
      mfaCode: {
        count: vi.fn(async ({ where }: any) => {
          return mfaCodes.filter(
            (c) => c.userId === where.userId && c.createdAt >= where.createdAt.gte
          ).length;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const c of mfaCodes) {
            if (c.userId === where.userId && c.consumedAt === null) {
              Object.assign(c, data);
              count++;
            }
          }
          return { count };
        }),
        create: vi.fn(async ({ data }: any) => {
          const row = {
            id: `mfa_${mfaCodes.length + 1}`,
            createdAt: new Date(),
            consumedAt: null,
            ...data,
          };
          mfaCodes.push(row);
          return row;
        }),
        findMany: vi.fn(async ({ where }: any) => {
          return mfaCodes
            .filter(
              (c) =>
                c.userId === where.userId &&
                c.consumedAt === null &&
                c.expiresAt > where.expiresAt.gt
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = mfaCodes.find((c) => c.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        }),
      },
    },
  };
});

// Mock email — ne pas envoyer de mail pendant les tests
vi.mock('@/lib/email/send', () => ({
  sendMail: vi.fn(async () => {}),
}));

import {
  generateRandomCode,
  issueMfaCode,
  verifyMfaCode,
  MFA_CODE_LENGTH,
  MfaRateLimitError,
  MFA_MAX_CODES_PER_HOUR,
} from '@/lib/mfa';
import { prisma } from '@/lib/prisma';

describe('lib/mfa', () => {
  beforeEach(() => {
    // @ts-expect-error — accès au state du mock
    prisma.__state.mfaCodes.length = 0;
  });

  describe('generateRandomCode', () => {
    it('retourne une string de la bonne longueur', () => {
      const code = generateRandomCode();
      expect(code).toHaveLength(MFA_CODE_LENGTH);
    });

    it('ne contient que des chiffres', () => {
      for (let i = 0; i < 50; i++) {
        const code = generateRandomCode();
        expect(code).toMatch(/^\d{6}$/);
      }
    });

    it('produit des valeurs variées (entropie)', () => {
      const set = new Set<string>();
      for (let i = 0; i < 200; i++) {
        set.add(generateRandomCode());
      }
      // Avec 200 tirages sur 10^6 valeurs possibles on s'attend à ~200 uniques.
      // On tolère 180 pour éviter un flaky improbable.
      expect(set.size).toBeGreaterThanOrEqual(180);
    });
  });

  describe('issueMfaCode + verifyMfaCode', () => {
    it('le code émis est vérifiable puis marqué consommé', async () => {
      const code = await issueMfaCode('user_1');
      expect(code).toMatch(/^\d{6}$/);

      const ok = await verifyMfaCode('user_1', code);
      expect(ok).toBe(true);

      // Second appel : le code a été consommé, ne doit plus passer
      const okAgain = await verifyMfaCode('user_1', code);
      expect(okAgain).toBe(false);
    });

    it('refuse un code invalide', async () => {
      await issueMfaCode('user_1');
      const ok = await verifyMfaCode('user_1', '000000');
      expect(ok).toBe(false);
    });

    it('refuse un code au mauvais format', async () => {
      await issueMfaCode('user_1');
      expect(await verifyMfaCode('user_1', 'abcdef')).toBe(false);
      expect(await verifyMfaCode('user_1', '123')).toBe(false);
      expect(await verifyMfaCode('user_1', '1234567')).toBe(false);
    });

    it('un nouveau code invalide les anciens non consommés', async () => {
      const code1 = await issueMfaCode('user_1');
      const code2 = await issueMfaCode('user_1');

      // Le premier code ne doit plus être valide
      expect(await verifyMfaCode('user_1', code1)).toBe(false);
      // Le deuxième oui
      expect(await verifyMfaCode('user_1', code2)).toBe(true);
    });

    it('rate limit : bloque après MFA_MAX_CODES_PER_HOUR dans l\'heure', async () => {
      for (let i = 0; i < MFA_MAX_CODES_PER_HOUR; i++) {
        await issueMfaCode('user_rl');
      }
      await expect(issueMfaCode('user_rl')).rejects.toBeInstanceOf(MfaRateLimitError);
    });
  });
});
