/** Recensement des comptes jamais prouvés (S0, M2) : lecture seule, admin seulement, liens OAuth repérés. */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ refus: vi.fn(), users: vi.fn(), tenants: vi.fn(), ecritures: vi.fn() }));
vi.mock('@/lib/admin/authenticate', () => ({ authenticateAdmin: async (...a: unknown[]) => { const r = (await ((...a: unknown[]) => m.refus(...a))(...a)) as Response | null; return r ? { ok: false, response: r } : { ok: true, sessionEmail: null, hubUserId: null }; } }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findMany: (...a: unknown[]) => m.users(...a), update: m.ecritures, delete: m.ecritures },
    tenant: { findMany: (...a: unknown[]) => m.tenants(...a) },
    account: { deleteMany: m.ecritures },
  },
}));

import { GET } from '@/app/api/admin/comptes-sans-preuve/route';

const req = () => new NextRequest('https://app.veridian.site/api/admin/comptes-sans-preuve');

describe('GET /api/admin/comptes-sans-preuve', () => {
  it('sans admin : refusé, rien n\'est lu', async () => {
    m.refus.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await GET(req())).status).toBe(401);
    expect(m.users).not.toHaveBeenCalled();
  });

  it('ne lit que les comptes jamais prouvés, repère les liens OAuth, n\'écrit rien', async () => {
    m.refus.mockResolvedValue(null);
    m.users.mockResolvedValue([
      { id: 'a', email: 'pre-prise@acme.fr', createdAt: new Date('2026-11-01'), supabaseUserId: 'h-a', sessionsValidAfter: null, accounts: [{ provider: 'microsoft-entra-id' }] },
      { id: 'b', email: 'inscrit@acme.fr', createdAt: new Date('2026-11-02'), supabaseUserId: 'h-b', sessionsValidAfter: null, accounts: [{ provider: 'credentials' }] },
    ]);
    m.tenants.mockResolvedValue([{ userId: 'h-a' }]);
    const j = await (await GET(req())).json();
    expect(m.users.mock.calls[0][0]).toMatchObject({ where: { emailVerified: null } });
    expect(j.total).toBe(2);
    expect(j.avec_lien_oauth).toBe(1);
    expect(j.comptes[0]).toMatchObject({ email: 'pre-prise@acme.fr', lien_oauth_sans_preuve: true, tenants: 1, mot_de_passe: false });
    expect(j.comptes[1]).toMatchObject({ lien_oauth_sans_preuve: false, mot_de_passe: true, tenants: 0 });
    expect(m.ecritures).not.toHaveBeenCalled();
  });
});
