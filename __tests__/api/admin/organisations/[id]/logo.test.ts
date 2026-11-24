// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), regler: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/organisations/reglage', () => ({ reglerOrganisation: (...a: unknown[]) => m.regler(...a) }));

import { DELETE, PUT } from '@/app/api/admin/organisations/[id]/logo/route';

const T = '11111111-1111-4111-8111-111111111111';
const ctx = (id = T) => ({ params: Promise.resolve({ id }) });
const req = (method: string, h: Record<string, string> = {}) => new NextRequest('https://h/x', { method, headers: h, ...(method === 'PUT' ? { body: Buffer.from('img') } : {}) });
beforeEach(() => { vi.clearAllMocks(); m.admin.mockResolvedValue(null); m.regler.mockResolvedValue({ emissions: [] }); });

describe('logo', () => {
  it('PUT passe les octets ; DELETE retire', async () => {
    expect((await PUT(req('PUT'), ctx())).status).toBe(200);
    expect(m.regler.mock.calls[0][1].logo.toString()).toBe('img');
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(200);
    expect(m.regler.mock.calls[1][1].logo).toBeNull();
  });
  it('refus : format 415, poids 413, tenant 404, identifiant 400', async () => {
    for (const [refus, s] of [['format_refuse', 415], ['trop_gros', 413], ['tenant_introuvable', 404]] as const) { m.regler.mockResolvedValue({ refus }); expect((await PUT(req('PUT'), ctx())).status).toBe(s); }
    expect((await PUT(req('PUT', { 'content-length': '9000000' }), ctx())).status).toBe(413);
    expect((await DELETE(req('DELETE'), ctx('x'))).status).toBe(400);
  });
  it('admin seulement', async () => {
    m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect([(await PUT(req('PUT'), ctx())).status, (await DELETE(req('DELETE'), ctx())).status]).toEqual([401, 401]);
    expect(m.regler).not.toHaveBeenCalled();
  });
});
