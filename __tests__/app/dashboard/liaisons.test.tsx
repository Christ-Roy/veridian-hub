// @vitest-environment node
/** Page Liaisons : qui voit quel bouton. Les droits réels sont revérifiés par reglerIntegration. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), espaces: vi.fn(), role: vi.fn(), lister: vi.fn() }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'i' } }) }));
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/mcp/catalogue', () => ({ espacesDe: () => m.espaces() }));
vi.mock('@/lib/delegation/interrupteur', () => ({ roleAuHub: () => m.role(), listerIntegrations: () => m.lister() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import Liaisons from '@/app/dashboard/liaisons/page';

const ligne = (o: object = {}) => ({ paire: 'prospection>crm', libelle: 'Prospection vers CRM', etat: 'eteinte', consentie: false, dernier_passage: null, derniere_erreur: null, ...o });
const html = async (avis?: string) => renderToStaticMarkup(await Liaisons({ searchParams: Promise.resolve({ avis }) }));
const boutons = async () => [/>Allumer</.test(await html()), />Couper</.test(await html())];
beforeEach(() => {
  m.user.mockResolvedValue({ supabaseUserId: 'u' });
  m.espaces.mockResolvedValue([{ id: 'A', nom: 'Atelier', slug: 'a', role: 'owner' }]);
  m.role.mockResolvedValue('owner');
  m.lister.mockResolvedValue([ligne()]);
});

describe('/dashboard/liaisons', () => {
  it('propriétaire : allume une liaison neuve, coupe une allumée', async () => {
    expect(await boutons()).toEqual([true, false]);
    m.lister.mockResolvedValue([ligne({ etat: 'allumee', consentie: true })]);
    expect(await boutons()).toEqual([false, true]);
  });
  it('par défaut : le dit, et se coupe ; réglée : ne le dit pas', async () => {
    m.lister.mockResolvedValue([ligne({ etat: 'allumee', par_defaut: true })]);
    expect([(await html()).includes('Active par défaut'), ...(await boutons())]).toEqual([true, false, true]);
    m.lister.mockResolvedValue([ligne({ etat: 'allumee', consentie: true, par_defaut: false })]);
    expect((await html()).includes('par défaut')).toBe(false);
  });
  it('admin : rallume ce que le propriétaire a consenti, pas une liaison neuve', async () => {
    m.role.mockResolvedValue('admin');
    expect(await boutons()).toEqual([false, false]);
    m.lister.mockResolvedValue([ligne({ consentie: true })]);
    expect(await boutons()).toEqual([true, false]);
  });
  it('membre : voit, ne règle rien', async () => {
    m.role.mockResolvedValue('member');
    m.lister.mockResolvedValue([ligne({ etat: 'allumee', consentie: true })]);
    expect(await boutons()).toEqual([false, false]);
    expect(await html()).toContain('Prospection vers CRM');
  });
  it('l\'en-tête ne promet plus « aucun mail » : une liaison de séquences en envoie (26/11)', async () => {
    const h = await html();
    expect([h.includes('aucun mail n'), h.includes('seule une liaison qui le dit peut envoyer des mails')]).toEqual([false, true]);
  });
  it('rien de servi : une phrase, aucun bouton mort', async () => {
    m.lister.mockResolvedValue([ligne({ etat: 'indisponible' })]);
    expect(await html()).toContain('Aucune liaison');
    expect(await boutons()).toEqual([false, false]);
  });
  it('l\'avis vient d\'une liste fermée : rien de l\'adresse n\'est écrit dans la page', async () => {
    expect(await html('eteinte')).toContain('Liaison coupée.');
    expect(await html('<b>pirate</b>')).not.toContain('pirate');
  });
  it('sans session : vers la connexion', async () => {
    m.user.mockResolvedValue(null);
    await expect(html()).rejects.toThrow('redirect /login?callbackUrl=/dashboard/liaisons');
  });
});
