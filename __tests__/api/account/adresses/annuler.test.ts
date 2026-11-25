// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ annuler: vi.fn() }));
vi.mock('@/lib/adresses/annulation', () => ({ annuler: (...a: unknown[]) => m.annuler(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/account/adresses/annuler/route';

let ip = 0;
const poster = (token?: string, meme?: string) => POST(new NextRequest('https://h/x', { method: 'POST', headers: { 'x-forwarded-for': meme ?? `203.0.113.${++ip}`, 'content-type': 'application/x-www-form-urlencoded' }, body: token ? `token=${token}` : 'x=1' }));
beforeEach(() => { vi.clearAllMocks(); m.annuler.mockResolvedValue({ rendue: true, appsEnEchec: [] }); });

describe('POST', () => {
  it('rend la main à la page, sans le jeton dans l\'adresse, sans cache', async () => {
    const r = await poster('jeton');
    expect([r.status, r.headers.get('location'), r.headers.get('cache-control'), r.headers.get('set-cookie')]).toEqual([303, 'https://app.veridian.site/auth/adresse?result=rendue', 'no-store', null]);
    expect(m.annuler.mock.calls[0][1]).toBe('jeton');
  });
  it('refus dit', async () => {
    m.annuler.mockResolvedValue({ refus: 'prise' });
    expect((await poster('j')).headers.get('location')).toContain('result=prise');
    m.annuler.mockResolvedValue({ refus: 'invalide' });
    expect((await poster()).headers.get('location')).toContain('result=invalide');
  });
  it('débit borné', async () => {
    const s: number[] = [];
    for (let n = 0; n < 12; n++) s.push((await poster('j', '198.51.100.7')).status);
    expect([s[9], s[11]]).toEqual([303, 429]);
  });
});
