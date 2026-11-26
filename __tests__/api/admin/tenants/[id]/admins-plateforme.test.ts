// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), designer: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: () => m.admin() }));
vi.mock('@/lib/admin/session-admin', () => ({ sessionAdmin: async () => ({ ok: true, hubUserId: 'h-robert', email: 'r@v' }) }));
vi.mock('@/lib/admin/audit-log', () => ({ resolveActor: () => 'op', writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/apps/admins-plateforme', async (o) => ({ ...(await o<object>()), designerAdminsPlateforme: (...a: unknown[]) => m.designer(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/admin/tenants/[id]/admins-plateforme/route';

const T = '11111111-1111-4111-8111-111111111111';
const jouer = (corps: unknown = {}, h: Record<string, string> = {}, id = T) => POST(new NextRequest('https://h/x', { method: 'POST', body: JSON.stringify(corps), headers: h }), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.clearAllMocks(); m.admin.mockResolvedValue(null); m.designer.mockResolvedValue([{ app: 'notifuse', hubUserId: 'h', etat: 'admin' }]); });

describe('POST /api/admin/tenants/[id]/admins-plateforme', () => {
it('posé : 200, audité, l\'auteur est la personne connectée ; par la clé, l\'outil', async () => {
  const r = await jouer({ raison: 'appel' });
  expect([r.status, await r.json()]).toEqual([200, { designations: [{ app: 'notifuse', hubUserId: 'h', etat: 'admin' }] }]);
  expect(m.designer.mock.calls[0][2]).toEqual({ acteur: 'h-robert', raison: 'appel' });
  expect(m.audit.mock.calls[0][1]).toMatchObject({ action: 'admin.tenant.admins_plateforme', targetId: T });
  await jouer({}, { 'x-admin-secret': 's' });
  expect(m.designer.mock.calls[1][2]).toMatchObject({ acteur: 'cle:ADMIN_SECRET' });
});
it('un échec : 207 ; retiré par le client n\'est pas un échec', async () => {
  m.designer.mockResolvedValue([{ app: 'notifuse', hubUserId: 'h', etat: 'echec' }]);
  expect((await jouer()).status).toBe(207);
  m.designer.mockResolvedValue([{ app: 'notifuse', hubUserId: 'h', etat: 'retire_par_le_client' }]);
  expect((await jouer()).status).toBe(200);
});
it('identifiant faux, champ inconnu : 400 ; organisation inconnue : 404 ; sans droit : rien', async () => {
  expect([(await jouer({}, {}, 'x')).status, (await jouer({ reinstate: true })).status]).toEqual([400, 400]);
  m.designer.mockResolvedValue(null);
  expect((await jouer()).status).toBe(404);
  m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
  m.designer.mockClear();
  expect((await jouer()).status).toBe(401);
  expect(m.designer).not.toHaveBeenCalled();
});

it('jamais de remise forcée : le corps ne porte que la raison', async () => {
  expect((await jouer({ raison: 'x', actor_hub_user_id: 'h' })).status).toBe(400);
  expect(m.designer).not.toHaveBeenCalled();
});
});
