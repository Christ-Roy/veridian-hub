/**
 * D6 : l'adresse est normalisée (trim, minuscules) au changement de profil. La base stocke
 * les adresses en minuscules : un changement en majuscules ne doit ni échapper au contrôle
 * de doublon, ni être stocké tel quel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { audits, users, updateMock, pushMock, decouvrirMock, moi } = vi.hoisted(() => ({
  audits: [] as object[],
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
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async (_d: unknown, l: object) => { audits.push(l); } }));
vi.mock('@/lib/auth/email-proof', () => ({ issueEmailProof: vi.fn(async () => true) }));
// La VRAIE garde (lib/adresses/garde) : seules les apps sont jouées.
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => pushMock(...a) }));
vi.mock('@/lib/sync/discovery', () => ({ configuredSyncApps: () => ['notifuse', 'prospection', 'analytics', 'crm', 'academy'] }));
vi.mock('@/lib/sync/appartenance', () => ({ humainsDe: async (app: string) => { const r = await decouvrirMock(app); return 'error' in r ? { raison: r.error } : { humains: [{ email: 'autre@x.fr', hub_user_id: null }, { email: 'A@x.fr', hub_user_id: 'un-autre' }, ...(r.found ? [{ email: 'a@X.fr', hub_user_id: null }, { email: 'jean@ancien.test', hub_user_id: null }, { email: 'moi@x.fr' }] : [])] }; } }));

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
    audits.length = 0;
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

  it.each([['notifuse', 'non_reliee', /^Mail ne vous connaît que par/], ['crm', 'non_reliee', /^Le CRM ne vous connaît que par/], ['academy', 'par_adresse', /^Academy vous reconnaît/]] as const)('chez %s (%s) : refusé, rien ne change, et il lit pourquoi', async (app, cas, dit) => {
    if (cas === 'par_adresse') chez[app] = 'ok';
    else decouvrirMock.mockImplementation(async (a: string) => ({ found: a === app }));
    const res = await PATCH(req({ email: 'neuve@x.fr' }));
    const j = await res.json();
    expect([res.status, j.error, j.apps]).toEqual([409, `app_${cas}`, [app]]);
    expect(j.message).toMatch(dit);
    expect(j.message).toMatch(/votre adresse actuelle continue de marcher partout/);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await PATCH(req({ name: 'Autre nom' }))).status, 'le nom, lui, change').toBe(200);
    expect(audits, 'rien n\'a changé d\'adresse').toEqual([]);
  });

  it('relié chez Mail et au CRM, ou absent : il passe ; une app muette : refusé', async () => {
    Object.assign(chez, { notifuse: 'ok', crm: 'ok' });
    expect((await PATCH(req({ email: 'neuve@x.fr' }))).status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([{ action: 'adresse.changee', actor: 'user:u1', targetType: 'user', targetId: 'u1' }]);
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
