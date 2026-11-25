// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), active: vi.fn() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/tenants/actif', () => ({ COOKIE_ACTIF: 'veridian_org', organisationActive: (...a: unknown[]) => m.active(...a) }));

import { POST } from '@/app/api/organisations/active/route';

const T = '11111111-1111-4111-8111-111111111111';
const jouer = async (tenant = T, origin = 'https://app.veridian.site') => {
  const f = new FormData();
  f.set('tenant', tenant);
  const r = await POST(new NextRequest('https://0.0.0.0/x', { method: 'POST', body: f, headers: { origin } }));
  return { s: r.status, l: r.headers.get('location') ?? '', c: r.headers.get('set-cookie') ?? '' };
};
beforeEach(() => { m.user.mockResolvedValue({ supabaseUserId: 'u' }); m.active.mockReset().mockResolvedValue(T); });

describe('POST organisation active', () => {
  it('membre : cookie httpOnly, sûr, lax', async () => {
    const r = await jouer();
    expect(r.l).toContain('avis=active');
    expect(r.c).toMatch(new RegExp(`veridian_org=${T}.*HttpOnly`, 'i'));
    expect(r.c).toMatch(/Secure/i);
  });
  it('pas membre, identifiant faux, autre site, sans session : aucun cookie', async () => {
    m.active.mockResolvedValue(null);
    expect(await jouer()).toMatchObject({ c: '' });
    expect((await jouer('x')).c).toBe('');
    expect(await jouer(T, 'https://pirate.test')).toMatchObject({ s: 403, c: '' });
    m.user.mockResolvedValue(null);
    expect(await jouer()).toMatchObject({ c: '', l: expect.stringContaining('/login') });
  });
});
