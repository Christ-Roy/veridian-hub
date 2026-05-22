/**
 * Tests structuraux des redirects auth de `next.config.js`.
 *
 * Les routes `/signin` et `/signin1` étaient d'anciennes pages stub
 * `redirect('/login')` (template shadcn). Elles ont été supprimées au profit
 * de redirects 308 gérés par Next — c'est plus léger (pas de bundle React pour
 * 4 lignes) et /login reste l'entrée canonique d'auth.
 *
 * Ce test est un garde-fou : si quelqu'un retire ces redirects, les vieux
 * liens /signin envoyés par mail ou indexés tombent en 404 silencieusement.
 */

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require('../../next.config.js');

describe('next.config.js — redirects auth dépréciées', () => {
  it('expose une fonction async redirects()', () => {
    expect(typeof nextConfig.redirects).toBe('function');
  });

  it('redirige /signin et /signin1 vers /login en 308 permanent', async () => {
    const redirects = await nextConfig.redirects();
    const bySource = Object.fromEntries(
      redirects.map((r: { source: string }) => [r.source, r]),
    );

    expect(bySource['/signin']).toMatchObject({
      destination: '/login',
      permanent: true,
    });
    expect(bySource['/signin1']).toMatchObject({
      destination: '/login',
      permanent: true,
    });
  });
});
