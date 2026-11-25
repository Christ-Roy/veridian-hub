import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ ip: vi.fn(), lien: vi.fn(), renouveler: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/auth/rate-limit', () => ({ extractClientIp: () => 'ip', renouvellementIpLimiter: { enforceWithBypass: () => m.ip() }, renouvellementLienLimiter: { enforceWithBypass: () => m.lien() } }));
vi.mock('@/lib/onboarding/service', () => ({ renouvelerLienActivation: () => m.renouveler() }));

import { POST } from '@/app/api/onboarding/[token]/renouveler/route';

const appel = async () => {
  const r = await POST(new Request('https://h/', { method: 'POST' }) as never, { params: Promise.resolve({ token: 't' }) });
  return { statut: r.status, corps: await r.json() };
};
beforeEach(() => {
  vi.clearAllMocks();
  m.ip.mockReturnValue({ ok: true });
  m.lien.mockReturnValue({ ok: true });
  m.renouveler.mockResolvedValue({ issue: 'envoye', userId: 'u' });
});

describe('POST /api/onboarding/[token]/renouveler', () => {
  it('envoyé : audité, et la réponse ne dit ni adresse ni lien', async () => {
    expect(await appel()).toEqual({ statut: 200, corps: { code: 'envoye' } });
    expect(m.audit.mock.calls[0][1]).toMatchObject({ action: 'onboarding.lien_renouvele', targetId: 'u', payload: {} });
  });
  it.each([['invalide', 404], ['actif', 409], ['encore_valable', 409]])('%s : %i, rien au journal', async (issue, statut) => {
    m.renouveler.mockResolvedValue({ issue });
    expect((await appel()).statut).toBe(statut);
    expect(m.audit).not.toHaveBeenCalled();
  });
  it.each(['ip', 'lien'] as const)('trop de demandes par %s : rien n\'est cherché', async (q) => {
    m[q].mockReturnValue({ ok: false, retryAfterSeconds: 9 });
    expect((await appel()).statut).toBe(429);
    expect(m.renouveler).not.toHaveBeenCalled();
  });
  it('une panne du service ne s\'affiche pas comme un envoi', async () => {
    m.renouveler.mockRejectedValue(new Error('mail'));
    await expect(appel()).rejects.toThrow('mail');
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('le lien est limité par son empreinte, pas par sa valeur', async () => {
    await appel();
    expect(m.lien).toHaveBeenCalledTimes(1);
  });
});
