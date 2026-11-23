import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ refus: null as Response | null }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: async () => m.refus }));
import { GET } from '@/app/api/admin/ip-vue/route';

const req = () => new NextRequest('https://app.veridian.site/api/admin/ip-vue', { headers: { 'x-forwarded-for': '198.51.100.7, 172.70.1.2', 'cf-connecting-ip': '9.9.9.9' } });
beforeEach(() => { m.refus = null; });

describe('GET /api/admin/ip-vue', () => {
  it('rend la clé retenue pour l\'appelant, sans croire l\'en-tête forgé', async () => {
    expect(await (await GET(req())).json()).toEqual({ cle: '198.51.100.7', ip: '198.51.100.7', source: 'avant-pair', elements: 2 });
  });
  it('non admin : refus', async () => {
    m.refus = new Response('{}', { status: 403 });
    expect((await GET(req())).status).toBe(403);
  });
});
