// @vitest-environment node
import { NextResponse } from 'next/server';
import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ oidc: vi.fn(), saml: vi.fn() }));
vi.mock('@/lib/federation/oidc', async (o) => ({ ...(await o<object>()), demarrer: (...a: unknown[]) => m.oidc(...a) }));
vi.mock('@/lib/federation/saml', async (o) => ({ ...(await o<object>()), demarrerSaml: (...a: unknown[]) => m.saml(...a) }));

import { partir } from '@/lib/federation/depart';

const base = new URL('https://app.veridian.site');
m.oidc.mockResolvedValue({ url: 'https://idp/a', cookie: 'o' });
m.saml.mockResolvedValue({ url: 'https://idp/s', cookie: 's' });
const cookie = async (i: object, o = {}) => { const d = await partir(i as never, base, o); const r = NextResponse.json({}); d.poser(r); return [d.url, r.headers.get('set-cookie')]; };

it('OIDC : cookie Lax borné au retour ; qui relie ou essaie est transmis', async () => {
  const [url, c] = await cookie({ id: 'i' }, { relier: { userId: 'U' } });
  expect(url).toBe('https://idp/a');
  expect(c).toMatch(/veridian-federation=o; Path=\/api\/auth\/federation\/callback;.*Secure; HttpOnly; SameSite=lax/i);
  expect(m.oidc.mock.calls[0].slice(1)).toEqual(['https://app.veridian.site/api/auth/federation/callback', undefined, undefined, { userId: 'U' }, undefined, undefined, undefined]);
});
it('SAML : cookie SameSite=None, Secure, borné à la réponse postée', async () => {
  const [url, c] = await cookie({ id: 'i', protocole: 'saml' }, { essai: { userId: 'V' } });
  expect(url).toBe('https://idp/s');
  expect(c).toMatch(/veridian-federation-saml=s; Path=\/api\/auth\/federation\/saml;.*Max-Age=600;.*Secure; HttpOnly; SameSite=none/i);
  expect(m.saml.mock.calls[0][2]).toEqual({ essai: { userId: 'V' } });
});
