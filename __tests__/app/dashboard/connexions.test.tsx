// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), liste: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: () => 'h' }));
vi.mock('@/lib/connecteurs/coffre', () => ({ connexionsDe: () => m.liste() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import Connexions from '@/app/dashboard/connexions/page';

const html = async (avis?: string) => renderToStaticMarkup(await Connexions({ searchParams: Promise.resolve({ avis }) }));
const gestes = (h: string) => [...h.matchAll(/aria-label="([^"]+)"/g)].map((x) => x[1]);
beforeEach(() => {
  m.user.mockResolvedValue({ id: 'U' });
  m.liste.mockResolvedValue([{ cle: 'notion', nom: 'Notion', texte: 'x', etat: 'absente' }, { cle: 'linear', nom: 'Linear', texte: 'y', etat: 'active' }, { cle: 'canva', nom: 'Canva', texte: 'z', etat: 'a_rebrancher' }]);
});

it('chacun son geste : brancher, couper, rebrancher ; aucun champ de clé', async () => {
  const h = await html();
  expect(gestes(h)).toEqual(['Brancher Notion', 'Couper Linear', 'Brancher Canva', 'Couper Canva']);
  expect(h).toContain('href="/dashboard/liaisons"');
  expect([h.includes('Rebrancher'), /type="(password|text)"/.test(h)]).toEqual([true, false]);
});
it('l\'avis se dit, un avis inconnu ne dit rien', async () => {
  expect(await html('branchee')).toContain('Branché.');
  expect(await html('<script>')).not.toContain('role="status"');
});
it('déconnecté : à la connexion', async () => {
  m.user.mockResolvedValue(null);
  await expect(html()).rejects.toThrow('redirect /login');
});
