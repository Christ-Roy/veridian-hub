// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), ouvrir: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/admin/authenticate', () => ({ authenticateAdmin: async (...a: unknown[]) => { const r = (await (() => m.admin())(...a)) as Response | null; return r ? { ok: false, response: r } : { ok: true, sessionEmail: null, hubUserId: null, admin: (a[0] as Request).headers.get("x-admin-secret") ? undefined : { userId: "u-robert", hubUserId: "h-robert", email: "r@v" } }; } }));
vi.mock('@/lib/admin/audit-log', () => ({ resolveActor: () => 'op', writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/apps/ouvrir', () => ({ ouvrirApps: (...a: unknown[]) => m.ouvrir(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/admin/session-admin', () => ({ sessionAdmin: async () => ({ ok: true, hubUserId: 'h-robert', email: 'r@v' }) }));

import { POST } from '@/app/api/admin/tenants/[id]/ouvrir/route';

const T = '11111111-1111-4111-8111-111111111111';
const jouer = (corps: unknown, id = T) => POST(new NextRequest('https://h/x', { method: 'POST', body: JSON.stringify(corps) }), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.clearAllMocks(); m.admin.mockResolvedValue(null); m.ouvrir.mockResolvedValue({ verdict: 'complet', apps: [{ app: 'crm', etat: 'ouverte' }], admins: [] }); });

describe('POST', () => {
  it('complet : 200 ; en partie ou non abouti : 207 ; audité, sans doublon d\'app', async () => {
    expect((await jouer({ apps: ['crm', 'crm'] })).status).toBe(200);
    expect(m.ouvrir.mock.calls[0][2]).toEqual(['crm']);
    expect(m.audit.mock.calls[0][1]).toMatchObject({ action: 'admin.tenant.ouvrir', targetId: T });
    for (const verdict of ['en_partie', 'non_abouti']) {
      m.ouvrir.mockResolvedValue({ verdict, apps: [], admins: [] });
      expect((await jouer({ apps: ['crm'] })).status).toBe(207);
    }
  });
  it('corps faux, identifiant faux : 400 ; organisation inconnue : 404', async () => {
    expect([(await jouer({ apps: [] })).status, (await jouer({ apps: ['cms'] })).status, (await jouer({ apps: ['crm'], plus: 1 })).status, (await jouer({ apps: ['crm'] }, 'x')).status]).toEqual([400, 400, 400, 400]);
    m.ouvrir.mockResolvedValue(null);
    expect((await jouer({ apps: ['crm'] })).status).toBe(404);
  });
  it('la réponse dit chaque app', async () => expect(await (await jouer({ apps: ['crm'] })).json()).toEqual({ verdict: 'complet', apps: [{ app: 'crm', etat: 'ouverte' }], admins: [] }));
  it('l\'auteur des désignations : la personne connectée ; par la clé, l\'outil', async () => {
    await jouer({ apps: ['crm'] });
    expect(m.ouvrir.mock.calls[0][3]).toMatchObject({ auteur: 'h-robert' });
    await POST(new NextRequest('https://h/x', { method: 'POST', body: JSON.stringify({ apps: ['crm'] }), headers: { 'x-admin-secret': 's' } }), { params: Promise.resolve({ id: T }) });
    expect(m.ouvrir.mock.calls[1][3]).toMatchObject({ auteur: 'cle:ADMIN_SECRET' });
  });
  it('sans droit : rien', async () => {
    m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await jouer({ apps: ['crm'] })).status).toBe(401);
    expect(m.ouvrir).not.toHaveBeenCalled();
  });
});
