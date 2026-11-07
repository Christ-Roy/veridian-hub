/**
 * Contrat : toute session fabriquée par le Hub porte `authAt`, la date de connexion réelle.
 * Sans elle, la révocation la tient pour périmée dès la première coupure (cookie hint « connecté »
 * pendant que le Hub renvoie au login) et la preuve récente la refuse.
 *
 * Trois façons de créer une session :
 *  1. Auth.js (mot de passe, Google, Microsoft) : callback `jwt` d'auth.ts, branche `user`.
 *  2. Un `encode()` de JWT de session posé à la main (One Tap, MFA, impersonation).
 *  3. Rien d'autre : toute nouvelle fabrique doit entrer dans la liste ci-dessous, avec son authAt.
 * Les tests de comportement de chaque chemin existent déjà (voir couverture.test.ts) ; ceci ferme la classe.
 */
import { describe, expect, it } from 'vitest';

import { code, sourcesApplicatives } from './source';

/** Fichiers autorisés à fabriquer un JWT de session avec `encode()`. */
const FABRIQUES_CONNUES = [
  'app/api/auth/callback/google-one-tap/route.ts',
  'app/api/auth/mfa/verify/route.ts',
  'lib/auth/impersonation.ts',
];

/** `encode(` appelé comme fonction libre, pas `TextEncoder().encode(` ni `x.encode(`. */
const APPEL_ENCODE = /(?<![.\w])encode\s*\(/g;
/** Fabriques de jeton signé autrement qu'avec Auth.js : toute nouvelle doit être examinée. */
const AUTRE_SIGNATURE = /\bnew SignJWT\b/;
/** Seul usage connu : le cookie « hint » de la landing, qui n'est pas une session. */
const SIGNJWT_CONNUS = ['lib/auth/session-hint-cookie.ts'];

/** Les ~700 caractères après chaque `encode(` : l'objet `token` y tient. */
function appels(src: string): string[] {
  return [...src.matchAll(APPEL_ENCODE)].map((m) => src.slice(m.index, (m.index ?? 0) + 700));
}

describe('outil : la détection d\'encode( voit les vrais appels et ignore les faux', () => {
  it('compte encode( libre, pas TextEncoder().encode(', () => {
    expect(appels('await encode({ token: {} })')).toHaveLength(1);
    expect(appels('new TextEncoder().encode(raw)')).toHaveLength(0);
    expect(appels('obj.encode(x)')).toHaveLength(0);
  });
});

describe('sessions fabriquées à la main', () => {
  const tous = sourcesApplicatives();

  it('chaque fabrique connue existe et appelle encode (la liste ne périme pas)', () => {
    for (const f of FABRIQUES_CONNUES) expect(appels(code(f)).length, f).toBeGreaterThan(0);
  });

  it('aucun encode( de session hors de la liste connue', () => {
    const inconnus = tous.filter((p) => !FABRIQUES_CONNUES.includes(p) && appels(code(p)).length > 0);
    expect(inconnus).toEqual([]);
  });

  it.each(FABRIQUES_CONNUES)('%s : chaque encode( porte authAt', (f) => {
    for (const a of appels(code(f))) expect(a).toMatch(/\bauthAt\s*:/);
  });

  it('aucune nouvelle signature de jeton (SignJWT) hors du cookie hint', () => {
    const inconnus = tous.filter((p) => !SIGNJWT_CONNUS.includes(p) && AUTRE_SIGNATURE.test(code(p)));
    expect(inconnus).toEqual([]);
  });
});

describe('sessions Auth.js (mot de passe, Google, Microsoft)', () => {
  it('le callback jwt pose authAt sur la connexion (branche `user`)', () => {
    const src = code('auth.ts');
    const jwt = src.slice(src.indexOf('async jwt('), src.indexOf('async session('));
    const brancheUser = jwt.slice(jwt.indexOf('if (user)'), jwt.indexOf('return token'));
    expect(brancheUser).toMatch(/token\.authAt\s*=\s*Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/);
  });

  it('authAt n\'est réécrit nulle part ailleurs que sur la connexion : une lecture ne rajeunit pas la session', () => {
    const src = code('auth.ts');
    const ecritures = src.match(/\btoken\.authAt\s*=(?!=)/g) ?? [];
    expect(ecritures).toHaveLength(1);
  });
});
