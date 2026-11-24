// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const trouver = vi.hoisted(() => vi.fn());
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: trouver } } }));

import { Compte, compteVise, IdTenant, refuser, rendre } from '@/lib/tenants/membres-http';
import { RefusMembre } from '@/lib/tenants/membres';

describe('membres-http', () => {
  it('Compte : une adresse ou un identifiant, pas rien', () => {
    expect(Compte.safeParse({}).success).toBe(false);
    expect(Compte.safeParse({ email: 'a@b.fr' }).success).toBe(true);
  });
  it('IdTenant : un uuid', () => expect(IdTenant.safeParse('x').success).toBe(false));
  it('compteVise : l\'identifiant tel quel, sinon l\'adresse sans casse, sinon null', async () => {
    expect(await compteVise({ hub_user_id: 'u' })).toBe('u');
    expect(trouver).not.toHaveBeenCalled();
    trouver.mockResolvedValueOnce({ supabaseUserId: 'v' }).mockResolvedValueOnce(null);
    expect(await compteVise({ email: 'A@b.fr' })).toBe('v');
    expect(trouver.mock.calls[0][0].where.email).toEqual({ equals: 'A@b.fr', mode: 'insensitive' });
    expect(await compteVise({ email: 'x@y.fr' })).toBeNull();
  });
  it('refuser : chaque code a son statut', () => {
    expect(refuser(new RefusMembre('tenant_suspendu')).status).toBe(409);
    expect(refuser(new RefusMembre('pas_membre')).status).toBe(404);
    expect(refuser(new RefusMembre('role_refuse')).status).toBe(400);
  });
  it('rendre : 207 tant qu\'une app n\'a pas suivi', () => expect([rendre({ complet: true }).status, rendre({ complet: false }).status]).toEqual([200, 207]));
});
