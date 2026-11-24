// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ appel: vi.fn(), doc: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/delegation/jeton', () => ({ verifierAppel: (...a: unknown[]) => m.appel(...a) }));
vi.mock('@/lib/organisations/document', async (o) => ({ ...(await o<object>()), documentOrg: () => m.doc() }));

import { POST } from '@/app/api/organisations/lire/route';

const T = '11111111-1111-4111-8111-111111111111';
const lire = (corps: unknown = { hub_tenant_id: T }) => POST(new NextRequest('https://h/x', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) }));
beforeEach(() => { vi.clearAllMocks(); m.appel.mockResolvedValue({ app: 'academy' }); m.doc.mockResolvedValue({ modules: ['academy'], reglages: { academy: { a: 1 }, crm: { secret: 1 } } }); });

describe('POST lire', () => {
  it('l\'app cochée lit le document, sans les réglages des autres', async () => {
    const r = await lire();
    expect([r.status, (await r.json()).reglages]).toEqual([200, { academy: { a: 1 } }]);
    expect(m.appel.mock.calls[0][4]).toEqual(['academy', 'notifuse', 'prospection']);
  });
  it('app non cochée ou organisation non réglée : 404, la même réponse', async () => {
    m.doc.mockResolvedValue({ modules: [], reglages: {} });
    expect((await lire()).status).toBe(404);
    m.doc.mockResolvedValue(null);
    expect((await lire()).status).toBe(404);
  });
  it('signature refusée, corps faux ou trop long : rien n\'est lu', async () => {
    m.appel.mockResolvedValue({ statut: 401, error: 'invalid_signature' });
    expect((await lire()).status).toBe(401);
    m.appel.mockResolvedValue({ app: 'academy' });
    expect((await lire('{')).status).toBe(400);
    expect((await lire({ hub_tenant_id: 'x' })).status).toBe(400);
    expect((await lire('x'.repeat(2_001))).status).toBe(400);
    expect(m.doc).not.toHaveBeenCalled();
  });
});
