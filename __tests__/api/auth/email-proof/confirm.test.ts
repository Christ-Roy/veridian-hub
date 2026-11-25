// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), consommer: vi.fn(), push: vi.fn(), mail: vi.fn(async (..._a: unknown[]) => 1) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/email-proof', () => ({ consumeEmailProof: (...a: unknown[]) => m.consommer(...a) }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => m.push(...a) }));
vi.mock('@/lib/notifuse/adresse', () => ({ suivreAdresseMail: m.mail }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { POST } from '@/app/api/auth/email-proof/confirm/route';

const confirmer = async () => { const f = new FormData(); f.set('token', 't'); const r = await POST(new NextRequest('https://h/x', { method: 'POST', body: f })); await new Promise((ok) => setTimeout(ok, 0)); return r.headers.get('location'); };
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: 'u', email: 'Neuve@x.fr', name: 'N', supabaseUserId: 'h1' });
  m.consommer.mockResolvedValue('proved');
  m.push.mockResolvedValue({ notifuse: 'ok' });
});

describe('POST confirm', () => {
  it('adresse prouvée : les apps suivent, puis l\'adresse que le Hub garde pour Mail', async () => {
    expect(await confirmer()).toBe('https://app.veridian.site/dashboard?email_proof=ok');
    expect(m.push.mock.calls[0][0]).toEqual({ hubUserId: 'h1', email: 'Neuve@x.fr', name: 'N' });
    expect(m.mail.mock.calls.map((c) => c.slice(1))).toEqual([['h1', 'neuve@x.fr']]);
  });
  it('Mail n\'a pas suivi (absent, refus, panne), ou lien mort : l\'adresse gardée ne bouge pas', async () => {
    for (const issue of ['not_in_app', 'failed']) { m.push.mockResolvedValue({ notifuse: issue }); await confirmer(); }
    m.push.mockRejectedValue(new Error('panne'));
    await confirmer();
    m.consommer.mockResolvedValue('expired');
    expect(await confirmer()).toContain('result=expired');
    expect(m.mail).not.toHaveBeenCalled();
  });
});
