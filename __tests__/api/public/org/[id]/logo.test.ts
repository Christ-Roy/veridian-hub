// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ org: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { organisation: { findUnique: (...a: unknown[]) => m.org(...a) } } }));

import { GET } from '@/app/api/public/org/[id]/logo/route';

const T = '11111111-1111-4111-8111-111111111111';
const lire = (v = 'abc', id = T) => GET(new NextRequest(`https://h/x?v=${v}`), { params: Promise.resolve({ id }) });
beforeEach(() => m.org.mockReset().mockResolvedValue({ logo: new Uint8Array([1, 2]), logoEmpreinte: 'abc' }));

describe('GET logo public', () => {
  it('le PNG, figé par son empreinte, sans interprétation possible', async () => {
    const r = await lire();
    expect([r.status, r.headers.get('content-type'), r.headers.get('x-content-type-options')]).toEqual([200, 'image/png', 'nosniff']);
    expect(r.headers.get('cache-control')).toContain('immutable');
  });
  it('autre empreinte, aucun logo, identifiant faux : 404', async () => {
    expect((await lire('vieux')).status).toBe(404);
    m.org.mockResolvedValue({ logo: null, logoEmpreinte: null });
    expect((await lire('null')).status).toBe(404);
    expect((await lire('abc', 'x')).status).toBe(404);
  });
});
