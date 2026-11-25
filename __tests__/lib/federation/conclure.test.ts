// @vitest-environment node
/** Le chemin complet est dans __tests__/api/auth/federation/callback.test.ts ; ici, la sortie et le choix du fournisseur. */
import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ pret: vi.fn(async () => null) }));
vi.mock('@/auth', () => ({ auth: async () => null, signIn: async () => '' }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/federation/idp', async (o) => ({ ...(await o<object>()), idpPret: m.pret }));

import { conclure, idpDe, sortieDe } from '@/lib/federation/conclure';

const base = new URL('https://app.veridian.site');
it('sortieDe : la transaction est détruite à chaque retour, un refus se dit sans détail', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const s = sortieDe(base, { nom: 'c', chemin: '/x' });
  for (const r of [s.vers('/dashboard'), s.refus('reponse_refusee', 'détail interne')]) {
    expect(r.headers.get('set-cookie')).toMatch(/c=; Path=\/x;.*Max-Age=0/i);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('location')).not.toContain('interne');
  }
});
it('idpDe : même inactif seulement pour un essai', async () => {
  await idpDe({ idp: 'i' } as never);
  await idpDe({ idp: 'i', essai: { userId: 'U' } } as never);
  expect((m.pret.mock.calls as unknown[][]).map((c) => c[3])).toEqual([undefined, true]);
});
it('conclure : sans personne connectée, un essai ne vaut rien', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const r = await conclure({} as never, base, { id: 'i', tenantId: 'T' } as never, { essai: { userId: 'U' } } as never, { sub: 's', email: null, emailNie: true, nom: null }, sortieDe(base, { nom: 'c', chemin: '/x' }));
  expect(r.headers.get('location')).toContain('demande_expiree');
});
