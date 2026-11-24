// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ appel: vi.fn(), etat: vi.fn() }));
vi.mock('@/lib/delegation/jeton', () => ({ verifierAppel: (...a: unknown[]) => m.appel(...a), etatDesPaires: (...a: unknown[]) => m.etat(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/delegation/paires/route';

const jouer = (corps: unknown) => POST(new NextRequest('https://app.veridian.site/x', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) }));
const BON = { subject_grant: 'x'.repeat(43) };
beforeEach(() => {
  vi.clearAllMocks();
  m.appel.mockResolvedValue({ app: 'prospection' });
  m.etat.mockResolvedValue({ tenantId: 'T', paires: [] });
});

describe('POST /api/delegation/paires', () => {
  it('l\'état, jamais en cache', async () => {
    const r = await jouer(BON);
    expect([r.status, r.headers.get('cache-control'), await r.json()]).toEqual([200, 'no-store', { tenant_id: 'T', paires: [] }]);
  });
  it('signature d\'abord', async () => {
    m.appel.mockResolvedValue({ statut: 401, error: 'invalid_signature' });
    expect((await jouer(BON)).status).toBe(401);
    expect(m.etat).not.toHaveBeenCalled();
  });
  it('corps illisible, champ de plus, trop gros, poignée refusée', async () => {
    for (const c of ['{', { ...BON, tenant_id: 'T' }]) expect((await jouer(c)).status).toBe(400);
    expect((await jouer(`"${'x'.repeat(1_001)}"`)).status).toBe(413);
    m.etat.mockResolvedValue({ statut: 403, error: 'grant_invalid' });
    expect((await jouer(BON)).status).toBe(403);
  });
});
