/** Retraits CRM retenus par le fusible : liste (attente moins rejeu), et rejeu seulement fusible levé. */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const m = vi.hoisted(() => ({ lignes: [] as unknown[], push: vi.fn(), audit: vi.fn(), refus: null as unknown }));
vi.mock('@/lib/admin/authenticate', () => ({ authenticateAdmin: async (...a: unknown[]) => { const r = (await (async () => m.refus)(...a)) as Response | null; return r ? { ok: false, response: r } : { ok: true, sessionEmail: null, hubUserId: null }; } }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { auditLog: { findMany: async () => m.lignes } } }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => m.push(...a) }));

import { GET, POST } from '@/app/api/admin/crm-retraits/route';

const ligne = (action: string, targetId: string, t: string) => ({ action, targetId, payload: { raison: 'espace_vivant', espaces: 1 }, createdAt: new Date(t) });
const post = (corps: unknown) => POST(new NextRequest('https://app.veridian.site/api/admin/crm-retraits', { method: 'POST', body: JSON.stringify(corps) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.refus = null;
  m.lignes = [ligne('crm.retrait.attente', A, '2026-11-23T01:00:00Z'), ligne('crm.retrait.attente', B, '2026-11-23T02:00:00Z'), ligne('crm.retrait.rejoue', B, '2026-11-23T03:00:00Z')];
  m.push.mockResolvedValue({ crm: 'ok' });
});
afterEach(() => vi.unstubAllEnvs());

describe('/api/admin/crm-retraits', () => {
  it('liste : seulement ceux qui attendent encore, sans adresse', async () => {
    const j = await (await GET(new NextRequest('https://app.veridian.site/api/admin/crm-retraits'))).json();
    expect(j.retraits).toEqual([{ hub_user_id: A, depuis: '2026-11-23T01:00:00.000Z', raison: 'espace_vivant', espaces: 1 }]);
    expect(j.fusible).toBe(true);
    expect(JSON.stringify(j)).not.toContain('@');
  });

  it('rejeu refusé tant que le fusible est actif (409), rien ne part', async () => {
    const r = await post({ hub_user_id: A });
    expect(r.status).toBe(409);
    expect(m.push).not.toHaveBeenCalled();
  });

  it('fusible levé : rejoue un retrait en attente, trace, et refuse celui qui n\'attend plus', async () => {
    vi.stubEnv('CRM_RETRAIT_FUSIBLE', '0');
    expect((await post({ hub_user_id: A })).status).toBe(200);
    expect(m.push).toHaveBeenCalledWith({ hubUserId: A, deleted: true }, { apps: ['crm'] });
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'crm.retrait.rejoue', targetId: A }));
    expect((await post({ hub_user_id: B })).status).toBe(404);
  });

  it('échec du CRM : pas de trace de rejeu, il reste en attente', async () => {
    vi.stubEnv('CRM_RETRAIT_FUSIBLE', '0');
    m.push.mockResolvedValue({ crm: 'failed' });
    expect((await post({ hub_user_id: A })).status).toBe(502);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('identifiant invalide : 400 ; non admin : refus', async () => {
    expect((await post({ hub_user_id: 'x' })).status).toBe(400);
    m.refus = new Response('{}', { status: 403 });
    expect((await GET(new NextRequest('https://app.veridian.site/x'))).status).toBe(403);
  });
});
