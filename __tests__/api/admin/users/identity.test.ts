import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { user, account, push, audit } = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  account: { updateMany: vi.fn() },
  push: vi.fn(async () => ({ notifuse: 'ok' })),
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user, account } }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: push }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: audit, resolveActor: () => 'test' }));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: vi.fn(async () => ({ ok: true, sessionEmail: null })),
}));

import { POST } from '@/app/api/admin/users/identity/route';

const req = (body: unknown) =>
  new NextRequest('https://app.veridian.site/api/admin/users/identity', {
    method: 'POST',
    body: JSON.stringify(body),
  });
const row = { id: 'u1', email: 'a@x.fr', name: 'A', supabaseUserId: 'uuid-1', emailVerified: null };

describe('POST /api/admin/users/identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    user.findUnique.mockReset();
    user.update.mockReset();
  });

  it('nom sur une adresse non prouvée : pousse le nom, jamais l\'email', async () => {
    user.findUnique.mockResolvedValueOnce(row);
    user.update.mockResolvedValueOnce({ email: 'a@x.fr', name: 'Nouveau', emailVerified: null });
    const res = await POST(req({ email: 'a@x.fr', name: 'Nouveau' }));
    expect(res.status).toBe(200);
    expect(push).toHaveBeenCalledWith({ hubUserId: 'uuid-1', name: 'Nouveau' });
    expect(account.updateMany).not.toHaveBeenCalled();
  });

  it('email : l\'admin atteste, le compte suit, et l\'email part vers les apps', async () => {
    user.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    user.update.mockResolvedValueOnce({ email: 'b@x.fr', name: 'A', emailVerified: new Date() });
    const res = await POST(req({ email: 'a@x.fr', new_email: 'B@x.fr' }));
    expect(res.status).toBe(200);
    const data = user.update.mock.calls[0][0].data;
    expect(data.email).toBe('b@x.fr');
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(account.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', provider: 'credentials' },
      data: { providerAccountId: 'b@x.fr' },
    });
    expect(push).toHaveBeenCalledWith({ hubUserId: 'uuid-1', email: 'b@x.fr' });
    expect(audit).toHaveBeenCalled();
  });

  it('adresse déjà prise : 409, rien n\'est écrit ni poussé', async () => {
    user.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce({ id: 'autre' });
    const res = await POST(req({ email: 'a@x.fr', new_email: 'b@x.fr' }));
    expect(res.status).toBe(409);
    expect(user.update).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('compte inconnu : 404 ; rien à changer : 400', async () => {
    user.findUnique.mockResolvedValueOnce(null);
    expect((await POST(req({ email: 'x@x.fr', name: 'N' }))).status).toBe(404);
    expect((await POST(req({ email: 'x@x.fr' }))).status).toBe(400);
  });
});
