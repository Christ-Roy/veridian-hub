// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ appel: vi.fn(), echanger: vi.fn() }));
vi.mock('@/lib/delegation/jeton', () => ({ verifierAppel: (...a: unknown[]) => m.appel(...a), echanger: (...a: unknown[]) => m.echanger(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/delegation/jeton/route';

const BON = { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_grant: 'x'.repeat(43), audience: 'crm', scope: 'crm:tache.ecrire' };
const jouer = (corps: unknown) => POST(new NextRequest('https://app.veridian.site/api/delegation/jeton', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) }));
beforeEach(() => {
  vi.clearAllMocks();
  m.appel.mockResolvedValue({ app: 'prospection' });
  m.echanger.mockResolvedValue({ jeton: 'J', tenantId: 'T', expiresIn: 120 });
});

describe('POST /api/delegation/jeton', () => {
  it('rend le jeton, jamais en cache ; le corps signé est celui reçu', async () => {
    const r = await jouer(BON);
    expect([r.status, r.headers.get('cache-control')]).toEqual([200, 'no-store']);
    expect(await r.json()).toEqual({ access_token: 'J', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 120, tenant_id: 'T' });
    expect(m.appel.mock.calls[0][2]).toBe(JSON.stringify(BON));
  });
  it('signature d\'abord : refusée, rien n\'est lu du corps', async () => {
    m.appel.mockResolvedValue({ statut: 401, error: 'invalid_signature' });
    expect((await jouer('{')).status).toBe(401);
    expect(m.echanger).not.toHaveBeenCalled();
  });
  it('corps illisible, autre grant_type, tenant_id glissé, trop gros : refusé', async () => {
    for (const c of ['{', { ...BON, grant_type: 'password' }, { ...BON, tenant_id: 'T2' }, { ...BON, subject_grant: 'court' }]) expect((await jouer(c)).status).toBe(400);
    expect((await jouer(`"${'x'.repeat(4_001)}"`)).status).toBe(413);
    expect(m.echanger).not.toHaveBeenCalled();
  });
  it('un refus garde son code', async () => {
    m.echanger.mockResolvedValue({ statut: 403, error: 'not_member' });
    const r = await jouer(BON);
    expect([r.status, await r.json()]).toEqual([403, { error: 'not_member' }]);
  });
});
