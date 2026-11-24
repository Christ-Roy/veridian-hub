// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), marquer: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/tenants/marque-test', () => ({ marquerTest: (...a: unknown[]) => m.marquer(...a) }));

import { POST } from '@/app/api/admin/tenants/[id]/test/route';

const T = '11111111-1111-4111-8111-111111111111';
const jouer = (corps: unknown, id = T) => POST(new NextRequest('https://app.veridian.site/x', { method: 'POST', body: JSON.stringify(corps) }), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue(null);
  m.marquer.mockResolvedValue({ expire_le: 'x' });
});

describe('POST marquage de test', () => {
  it('pose et retire', async () => {
    expect((await jouer({ poser: true })).status).toBe(200);
    expect(m.marquer.mock.calls[0][1]).toMatchObject({ tenantId: T, poser: true });
    expect((await jouer({ poser: false })).status).toBe(200);
  });
  it('vrai compte : 403 ; inconnu : 404 ; corps ou identifiant faux : 400', async () => {
    m.marquer.mockResolvedValue({ refus: 'compte_reel' });
    expect((await jouer({ poser: true })).status).toBe(403);
    m.marquer.mockResolvedValue({ refus: 'tenant_introuvable' });
    expect((await jouer({ poser: true })).status).toBe(404);
    expect((await jouer({ poser: 'oui' })).status).toBe(400);
    expect((await jouer({ poser: true }, 'x')).status).toBe(400);
  });
  it('admin seulement', async () => {
    m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await jouer({ poser: true })).status).toBe(401);
    expect(m.marquer).not.toHaveBeenCalled();
  });
});
