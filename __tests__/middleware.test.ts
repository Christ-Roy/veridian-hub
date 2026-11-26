// @vitest-environment node
/**
 * Middleware : la CSP à nonce s'ajoute SANS ouvrir ce qu'Auth.js fermait. Avec un handler, Auth.js v5 n'applique plus la redirection
 * d'un `authorized()` à false : le handler la rejoue, et ce test le garde (une page protégée sans session part vers /login).
 */
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-auth', () => ({ default: () => ({ auth: (h: unknown) => h }) }));

import { avecCsp } from '@/middleware';

const req = (chemin: string, user?: { id: string }) => Object.assign(new NextRequest(`https://app.veridian.site${chemin}`), { auth: user ? { user, expires: '2099-01-01' } : null }) as never;
afterEach(() => vi.unstubAllEnvs());

describe('middleware (avecCsp)', () => {
  it('page protégée sans session : redirection vers /login avec le retour, aucune page servie', async () => {
    const r = await avecCsp(req('/dashboard/organisation?x=1'));
    expect([r.status, new URL(r.headers.get('location')!).pathname, new URL(r.headers.get('location')!).searchParams.get('callbackUrl')]).toEqual([307, '/login', 'https://app.veridian.site/dashboard/organisation?x=1']);
  });
  it('avec session : la page passe, avec une CSP Report-Only à nonce neuf, aussi transmise à Next dans la requête', async () => {
    const a = await avecCsp(req('/dashboard', { id: 'u' }));
    const b = await avecCsp(req('/dashboard', { id: 'u' }));
    const csp = a.headers.get('content-security-policy-report-only')!;
    const n = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect([a.headers.get('x-middleware-next'), a.headers.get('content-security-policy'), !!n, n === /'nonce-([^']+)'/.exec(b.headers.get('content-security-policy-report-only')!)?.[1]]).toEqual(['1', null, true, false]);
    expect(a.headers.get('x-middleware-request-content-security-policy-report-only')).toBe(csp);
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
  it('CSP_MODE=appliquer : en-tête bloquant ; page publique sans session : servie avec la CSP', async () => {
    vi.stubEnv('CSP_MODE', 'appliquer');
    const r = await avecCsp(req('/login'));
    expect([r.headers.get('x-middleware-next'), !!r.headers.get('content-security-policy'), r.headers.get('content-security-policy-report-only')]).toEqual(['1', true, null]);
  });
});
