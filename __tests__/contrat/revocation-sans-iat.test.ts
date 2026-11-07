/**
 * Contrat : la révocation d'une session se lit sur `authAt` (connexion réelle), jamais sur `iat`.
 * Auth.js réécrit `iat` à chaque lecture de session, middleware compris : un vieux cookie y gagnait
 * un `iat` neuf et survivait à « se déconnecter partout » (mesuré en prod le 07/11).
 *
 * Preuve système : e2e/systeme-sso/08-session-longue.spec.ts (SSO_SABOTAGE=partout).
 * Ici : la garde rapide, qui échoue avant tout déploiement.
 */
import { describe, expect, it, vi } from 'vitest';

import { isSessionRevoked } from '@/lib/auth/session-revocation';

import { code, sansCommentaires, sourcesApplicatives } from './source';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const T = 1_800_000_000;
const avec = (row: unknown) => ({ user: { findUnique: vi.fn(async () => row) } }) as never;

describe('outil : sansCommentaires (la mesure ne tourne pas à vide)', () => {
  it('retire un commentaire, garde le code et les chaînes', () => {
    const src = "// iat ici\nconst a = t.iat; /* iat */ const b = 'iat';";
    const net = sansCommentaires(src);
    expect(net).toContain('t.iat');
    expect(net).toContain("'iat'");
    expect(net.match(/iat/g)).toHaveLength(2);
  });
});

describe('révocation : jamais `iat`', () => {
  it('aucun code applicatif ne lit ni ne teste `iat`', () => {
    const fautifs = sourcesApplicatives().filter((p) => /\biat\b/.test(code(p)));
    expect(fautifs).toEqual([]);
  });

  it('la date de révocation se compare à authAt : un iat tout neuf ne sauve pas, un iat très vieux ne condamne pas', async () => {
    const r = avec({ sessionsValidAfter: new Date(T * 1000) });
    expect(await isSessionRevoked(r, { uid: 'u', authAt: T - 1, iat: T + 99_999 } as never)).toBe(true);
    expect(await isSessionRevoked(r, { uid: 'u', authAt: T, iat: 1 } as never)).toBe(false);
  });

  it('le callback jwt d\'auth.ts appelle la révocation à chaque lecture de session', () => {
    const src = code('auth.ts');
    expect(src).toMatch(/isSessionRevoked\(\s*prisma\s*,\s*token\s*\)/);
    // Elle précède le `return token` final du callback : un retour anticipé la sauterait.
    const jwt = src.slice(src.indexOf('async jwt('), src.indexOf('async session('));
    expect(jwt.indexOf('isSessionRevoked')).toBeGreaterThan(jwt.indexOf('if (user)'));
    expect(jwt.indexOf('isSessionRevoked')).toBeLessThan(jwt.lastIndexOf('return token'));
  });
});
