// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), user: vi.fn(), emettre: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: (...a: unknown[]) => m.user(...a) } } }));
vi.mock('@/lib/delegation/poignee', () => ({ emettrePoignees: (...a: unknown[]) => m.emettre(...a) }));

import { POST } from '@/app/api/admin/delegation/poignee/route';

const jouer = (corps: unknown) => POST(new NextRequest('https://app.veridian.site/x', { method: 'POST', body: JSON.stringify(corps) }));
const TEST = { email: 'e2e-sso-a-b@veridian.site', app: 'prospection' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DEPLOY_ENV', 'prod');
  m.admin.mockResolvedValue(null);
  m.user.mockResolvedValue({ supabaseUserId: 'u' });
  m.emettre.mockResolvedValue([{ hub_tenant_id: 'T', grant: 'g', expire_le: 'e' }]);
});

describe('POST /api/admin/delegation/poignee', () => {
  it('un compte de test : ses poignées', async () => {
    const r = await jouer(TEST);
    expect([r.status, (await r.json()).delegations]).toEqual([200, [{ hub_tenant_id: 'T', grant: 'g', expire_le: 'e' }]]);
    expect(m.emettre.mock.calls[0][1]).toEqual({ hubUserId: 'u', app: 'prospection' });
  });
  it('un vrai compte en prod : 403, rien n\'est émis ; en staging, oui', async () => {
    expect((await jouer({ ...TEST, email: 'client@x.fr' })).status).toBe(403);
    expect(m.emettre).not.toHaveBeenCalled();
    vi.stubEnv('DEPLOY_ENV', 'staging');
    expect((await jouer({ ...TEST, email: 'client@x.fr' })).status).toBe(200);
  });
  it('une adresse de batterie sans organisation ouverte : rien n\'est émis, et c\'est dit par une liste vide', async () => {
    m.emettre.mockResolvedValue([]);
    const r = await jouer(TEST);
    expect([r.status, (await r.json()).delegations, r.headers.get('cache-control')]).toEqual([200, [], 'no-store']);
  });
  it('sans admin, corps invalide, compte absent : refusé', async () => {
    expect((await jouer({ ...TEST, app: 'cms' })).status).toBe(400);
    m.user.mockResolvedValue(null);
    expect((await jouer(TEST)).status).toBe(404);
    m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await jouer(TEST)).status).toBe(401);
    expect(m.emettre).not.toHaveBeenCalled();
  });
});
