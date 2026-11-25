// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), liste: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: () => 'h' }));
vi.mock('@/lib/connecteurs/coffre', () => ({ connexionsDe: () => m.liste() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import Connexions from '@/app/dashboard/connexions/page';

const html = async (avis?: string, service?: string) => renderToStaticMarkup(await Connexions({ searchParams: Promise.resolve({ avis, service }) })).replaceAll('&#x27;', '\'');
const S = (o: object) => ({ texte: 'x', compte: null, ecriture: false, saitEcrire: false, relu: true, attente: null, ...o });
const gestes = (h: string) => [...h.matchAll(/aria-label="([^"]+)"/g)].map((x) => x[1]);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CONNECTEURS_OUVERTS', '1');
  m.auth.mockResolvedValue({ user: {} });
  m.user.mockResolvedValue({ id: 'U' });
  m.liste.mockResolvedValue([S({ cle: 'notion', nom: 'Notion', etat: 'absente' }), S({ cle: 'linear', nom: 'Linear', etat: 'active' }), S({ cle: 'canva', nom: 'Canva', etat: 'a_rebrancher' })]);
});

it('chacun son geste : brancher, couper, rebrancher ; aucun champ de clé', async () => {
  const h = await html();
  expect(gestes(h)).toEqual(['Brancher Notion', 'Couper Linear', 'Brancher Canva', 'Couper Canva']);
  expect(h).toContain('href="/dashboard/liaisons"');
  expect([h.includes('Rebrancher'), /type="(password|text)"/.test(h)]).toEqual([true, false]);
});
it('fermé : rien à brancher, ce qui est branché se coupe', async () => {
  vi.stubEnv('CONNECTEURS_OUVERTS', '');
  expect(gestes(await html())).toEqual(['Couper Linear', 'Couper Canva']);
  m.liste.mockResolvedValue([]);
  expect(await html()).toContain('pas encore ouverte');
});
it('l\'avis se dit, un avis inconnu ne dit rien', async () => {
  expect(await html('branchee')).toContain('Branché, en lecture seule');
  expect(await html('<script>')).not.toContain('role="status"');
});
it('« coupé » n\'est dit de chez eux que confirmé', async () => {
  expect(await html('coupee', 'notion')).toContain('Notion l\'a confirmé');
  const h = await html('coupee_ici', 'notion');
  expect([h.includes('Coupé ici'), h.includes('n\'a pas confirmé la coupure'), h.includes('l\'a confirmé')]).toEqual([true, true, false]);
  expect(await html('coupee_ici', '<b>evil</b>')).not.toContain('evil');
  expect(await html('constructor')).not.toContain('role="status"');
});
it('lecture seule dite, écriture service par service ; fermé, elle s\'éteint mais ne s\'allume pas', async () => {
  m.liste.mockResolvedValue([S({ cle: 'notion', nom: 'Notion', etat: 'active', saitEcrire: true }), S({ cle: 'linear', nom: 'Linear', etat: 'active', saitEcrire: true, ecriture: true }), S({ cle: 'sentry', nom: 'Sentry', etat: 'active', relu: false })]);
  const h = await html();
  expect(gestes(h)).toEqual(['Allumer l\'écriture de Notion', 'Couper Notion', 'Éteindre l\'écriture de Linear', 'Couper Linear', 'Couper Sentry']);
  expect([h.includes('Lecture seule.'), h.includes('Lecture et écriture.'), h.includes('attendent notre relecture')]).toEqual([true, true, true]);
  vi.stubEnv('CONNECTEURS_OUVERTS', '');
  expect(gestes(await html())).toEqual(['Couper Notion', 'Éteindre l\'écriture de Linear', 'Couper Linear', 'Couper Sentry']);
});
it('rebranchement : les deux comptes montrés, deux choix ; fermé, seulement garder', async () => {
  m.liste.mockResolvedValue([S({ cle: 'notion', nom: 'Notion', etat: 'active', compte: 'ACME', attente: { compte: null } })]);
  const h = await html();
  expect([h.includes('Relié : ACME. Nouveau : nom non donné par le service.'), gestes(h)]).toEqual([true, ['Couper Notion', 'Prendre le nouveau compte de Notion', 'Garder le compte actuel de Notion']]);
  vi.stubEnv('CONNECTEURS_OUVERTS', '');
  expect(gestes(await html())).toEqual(['Couper Notion', 'Garder le compte actuel de Notion']);
});
it.each([['organisation', { user: { federe: true } }], ['emprunt', { user: { impersonated: true } }], ['sans session', null]])('session %s : ses connexions ne sont pas lues', async (_n, x) => {
  m.auth.mockResolvedValue(x);
  const h = await html();
  expect([m.liste.mock.calls.length, gestes(h), h.includes('votre propre connexion')]).toEqual([0, [], true]);
});
it('déconnecté : à la connexion', async () => {
  m.user.mockResolvedValue(null);
  await expect(html()).rejects.toThrow('redirect /login');
});
