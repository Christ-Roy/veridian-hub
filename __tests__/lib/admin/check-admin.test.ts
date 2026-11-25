// @vitest-environment node
/** Qui administre la plateforme : une personne désignée par son hub_user_id, adresse prouvée, session à elle. Jamais une adresse (VER-263). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ lire: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => m.lire(...a) } } }));

import { estAdresseOperateur, isPlatformAdmin, isPlatformAdminId } from '@/lib/admin/check-admin';
import { lireAdmins } from '@/lib/admin/liste-admins';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const AUTRE = '11111111-2222-4333-8444-555555555555';
const base = (u: object | null) => m.lire.mockResolvedValue(u);
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('PLATFORM_ADMINS', ` ${ROBERT.toUpperCase()} , ${AUTRE}`);
  vi.stubEnv('ADRESSES_OPERATEUR', 'Robert@X.fr');
  base({ supabaseUserId: ROBERT, emailVerified: new Date() });
});
const s = (o: object = {}) => ({ user: { id: 'u1', ...o } });

describe('lireAdmins', () => {
  it('lit une liste, casse et espaces compris', () => expect([...lireAdmins(` ${ROBERT.toUpperCase()} , ${AUTRE},`)!]).toEqual([ROBERT, AUTRE]));
  it.each([undefined, '', ' , ', 'robert@x.fr', `${ROBERT},robert@x.fr`, `${ROBERT};${AUTRE}`])('%j est illisible en entier', (l) => expect(lireAdmins(l)).toBeNull());
});

describe('isPlatformAdmin', () => {
  it('la personne désignée, adresse prouvée : oui', async () => expect(await isPlatformAdmin(s())).toBe(true));
  it('la même adresse que l\'administrateur, tapée à l\'inscription et pas prouvée, ou une autre personne : non', async () => {
    base({ supabaseUserId: 'inconnu', emailVerified: null });
    const copie = await isPlatformAdmin(s({ email: 'robert@x.fr' }));
    base({ supabaseUserId: 'inconnu', emailVerified: new Date() });
    const autre = await isPlatformAdmin(s({ email: 'robert@x.fr' }));
    base({ supabaseUserId: ROBERT, emailVerified: null });
    expect([copie, autre, await isPlatformAdmin(s())]).toEqual([false, false, false]);
  });
  it('session empruntée ou ouverte par le fournisseur d\'une organisation : non, sans lire la base', async () => {
    expect([await isPlatformAdmin(s({ impersonated: true })), await isPlatformAdmin(s({ federe: true }))]).toEqual([false, false]);
    expect(m.lire).not.toHaveBeenCalled();
  });
  it('sans session, sans identifiant, compte disparu ou base en panne : non', async () => {
    base(null);
    const rendu = [await isPlatformAdmin(null), await isPlatformAdmin({ user: {} }), await isPlatformAdmin(s())];
    m.lire.mockRejectedValue(new Error('base'));
    expect([...rendu, await isPlatformAdmin(s())]).toEqual([false, false, false, false]);
  });
  it.each(['', ' , ', 'x', `${AUTRE},robert@x.fr`])('liste illisible %j : personne promu ni déchu', async (l) => {
    vi.stubEnv('PLATFORM_ADMINS', l);
    const connu = await isPlatformAdmin(s());
    base({ email: 'a@x', supabaseUserId: AUTRE, emailVerified: new Date() });
    expect([connu, await isPlatformAdmin(s())]).toEqual([true, false]);
  });
  it('retiré d\'une liste lisible : plus administrateur', async () => { vi.stubEnv('PLATFORM_ADMINS', AUTRE); expect(await isPlatformAdmin(s())).toBe(false); });
  it('empruntée, marque posée à la racine de la session : non', async () => expect(await isPlatformAdmin({ ...s(), impersonated: true })).toBe(false));
});
it('isPlatformAdminId : liste exacte, casse indifférente', () => expect([isPlatformAdminId(ROBERT), isPlatformAdminId('x'), isPlatformAdminId(null), isPlatformAdminId('')]).toEqual([true, false, false, false]));
it('estAdresseOperateur : pour les rapports, ne donne aucun droit', () => expect([estAdresseOperateur(' robert@x.FR '), estAdresseOperateur('a@x.fr')]).toEqual([true, false]));
