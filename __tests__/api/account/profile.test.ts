/**
 * D6 : l'adresse est normalisée (trim, minuscules) au changement de profil. La base stocke
 * les adresses en minuscules : un changement en majuscules ne doit ni échapper au contrôle
 * de doublon, ni être stocké tel quel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { users, updateMock, pushMock, decouvrirMock, moi } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  decouvrirMock: vi.fn(),
  moi: { id: 'u1', email: 'moi@x.fr', name: 'Moi', supabaseUserId: 'h1' as string | null },
  users: new Map<string, { id: string; email: string }>(),
  updateMock: vi.fn(async () => ({})),
}));

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: async () => moi,
}));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/lib/auth/recent-auth', () => ({
  denyIfImpersonated: async () => null,
  denyUnlessRecentAuth: async () => null,
  PREUVE_COMPTE_S: 86400,
}));
vi.mock('@/lib/auth/email-proof', () => ({ issueEmailProof: vi.fn(async () => true) }));
// La VRAIE garde (lib/adresses/garde) : seules les apps sont jouées.
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => pushMock(...a) }));
vi.mock('@/lib/sync/discovery', () => ({ configuredSyncApps: () => ['notifuse', 'prospection', 'analytics', 'crm', 'academy'], discoverAppForEmail: (...a: unknown[]) => decouvrirMock(...a) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      // Base réelle : adresses stockées en minuscules. Une recherche exacte échoue sur `A@X`.
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
      update: updateMock,
    },
    account: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

import { PATCH } from '@/app/api/account/profile/route';

function req(body: unknown) {
  return new Request('http://localhost/api/account/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let chez: Record<string, string>;
describe('PATCH /api/account/profile : email normalisé (D6)', () => {
  beforeEach(() => {
    users.clear();
    users.set('moi@x.fr', { id: 'u1', email: 'moi@x.fr' });
    users.set('victime@x.fr', { id: 'u2', email: 'victime@x.fr' });
    updateMock.mockClear();
    moi.supabaseUserId = 'h1';
    chez = { prospection: 'ok' };
    pushMock.mockImplementation(async (_p: unknown, o?: { apps: string[] }) => Object.fromEntries((o?.apps ?? []).map((a) => [a, chez[a] ?? 'not_in_app'])));
    decouvrirMock.mockResolvedValue({ found: false });
  });

  it('une adresse déjà prise en majuscules donne 409 (même adresse, autre casse)', async () => {
    const res = await PATCH(req({ email: 'Victime@X.fr' }));
    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('une adresse saisie avec espaces et majuscules est stockée normalisée', async () => {
    const res = await PATCH(req({ email: '  Nouvelle@X.fr ' }));
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'nouvelle@x.fr' }) }),
    );
  });

  it.each([['notifuse', /^Mail vous reconnaît/], ['crm', /^Le CRM vous reconnaît/], ['academy', /^Academy vous reconnaît/]] as const)('un compte chez %s : refusé, rien ne change, et il lit pourquoi', async (app, dit) => {
    chez[app] = 'ok';
    const res = await PATCH(req({ email: 'neuve@x.fr' }));
    const j = await res.json();
    expect([res.status, j.error, j.apps]).toEqual([409, 'app_par_adresse', [app]]);
    expect(j.message).toMatch(dit);
    expect(j.message).toMatch(/votre adresse actuelle continue de marcher partout/);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await PATCH(req({ name: 'Autre nom' }))).status, 'le nom, lui, change').toBe(200);
  });

  it('ni Mail, ni CRM, ni Academy : il passe ; une app muette : refusé', async () => {
    expect((await PATCH(req({ email: 'neuve@x.fr' }))).status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    chez.analytics = 'failed';
    expect((await PATCH(req({ email: 'autre@x.fr' }))).status).toBe(503);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('compte sans identité Hub : seule l\'adresse peut le dire', async () => {
    moi.supabaseUserId = null;
    decouvrirMock.mockImplementation(async (a: string) => ({ found: a === 'crm' }));
    expect((await PATCH(req({ email: 'neuve@x.fr' }))).status).toBe(409);
    decouvrirMock.mockResolvedValue({ found: false });
    expect((await PATCH(req({ email: 'neuve@x.fr' }))).status).toBe(200);
  });
});
