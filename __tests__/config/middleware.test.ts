/**
 * Tests structuraux de `middleware.ts` — le middleware Auth.js v5 edge.
 *
 * **Pourquoi ces tests existent** : middleware.ts est dans le scope Nuclear
 * depuis 2026-05-21. Le fichier est trivial mais critique : il décide quelles
 * routes sont gardées par l'auth. Toute modif au `matcher` ou au branchement
 * NextAuth doit avoir une trace test.
 *
 * Les tests fonctionnels du callback `authorized()` sont dans
 * `auth-config.test.ts` (où vit la vraie logique). Ici on verrouille la
 * structure du middleware lui-même.
 */

import { NextRequest } from 'next/server';
import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('next-auth', () => ({ default: () => ({ auth: (h: unknown) => h }) }));

import { avecCsp } from '@/middleware';

// Static analysis — middleware.ts importe NextAuth qui dépend de next/server
// (pas résolvable dans Vitest sans setup). On vérifie la forme du source.
// Le runtime est validé par les E2E sur staging (auth-guards.spec.ts).
const source = fs.readFileSync(
  path.join(process.cwd(), 'middleware.ts'),
  'utf8',
);

describe('middleware.ts — exports edge-safe', () => {
  it('exporte middleware (auth enveloppant le handler CSP) + config (matcher)', () => {
    expect(source).toMatch(/export\s+const\s+middleware\s*=\s*auth\(avecCsp/);
    expect(source).toMatch(/const\s+\{\s*auth\s*\}\s*=\s*NextAuth\(authConfig\)/);
    expect(source).toMatch(/export\s+const\s+config\s*=\s*\{[\s\S]*?matcher:/);
  });
});

describe('middleware.ts — matcher exclusions', () => {
  it('exclut _next/static (sinon middleware tape sur tous les assets statiques)', () => {
    expect(source).toMatch(/_next\/static/);
  });

  it('exclut _next/image (sinon middleware tape sur l\'optimizer Next)', () => {
    expect(source).toMatch(/_next\/image/);
  });

  it('exclut favicon.ico (sinon middleware tape sur le favicon)', () => {
    expect(source).toMatch(/favicon\.ico/);
  });

  it('exclut les images statiques (svg|png|jpg|jpeg|gif|webp)', () => {
    expect(source).toMatch(/svg\|png\|jpg\|jpeg\|gif\|webp/);
  });

  it('exclut api/pricing/plans (route publique cachable edge — sinon Set-Cookie Auth.js casse le cache CDN)', () => {
    // Critique perf : sans cette exclusion, le middleware Auth.js injecte
    // __Host-authjs.csrf-token + __Secure-authjs.callback-url, ce qui
    // invalide le cache edge (RFC 7234 §3). Notifuse Go consomme cet
    // endpoint au boot — sans cache edge, ~200ms par hit au lieu de ~20ms.
    // Cf. todo/2026-05-21-fix-cache-cookies-pricing-plans.md.
    expect(source).toMatch(/api\/pricing\/plans/);
  });

  it('exclut /api/vivant, et lui seul (VER-270) : la sonde du healthcheck Traefik ne lit aucune session ni ne pose de cookie', () => {
    const motif = source.match(/'(\/\(\(\?![^']+\)\.\*\))'/)?.[1];
    expect(motif, 'matcher lu dans la source').toBeTruthy();
    const passe = (chemin: string) => new RegExp(`^${motif!.replace(/\\\\/g, '\\')}$`).test(chemin);
    expect(['/api/vivant', '/api/vivantx', '/api/vivant/x', '/api/health', '/dashboard'].map(passe)).toEqual([false, true, true, true, true]);
  });

  it('exclut les routes qui remplacent la session (VER-263) : le middleware reposerait l\'ancienne par-dessus', () => {
    for (const r of ['api/admin/emprunt', 'api/auth/emprunt', 'api/auth/impersonate-callback']) expect(source).toMatch(new RegExp(`\\(\\?![^']*\\|${r}\\|`));
  });

  it('le matcher applique l\'exclusion en negative lookahead (pas en pattern séparé)', () => {
    // L'exclusion doit être DANS le `(?!...)` du matcher unique, pas dans
    // un pattern parallèle (sinon le matcher est toujours évalué sur la
    // route).
    expect(source).toMatch(/\(\?!.*api\/pricing\/plans/);
  });

  it('utilise auth.config (PAS auth.ts) — edge-safe sans Prisma', () => {
    // Si quelqu'un importe @/auth dans middleware.ts, le middleware crashe
    // au démarrage (Prisma n'est pas edge-compatible). Ce test verrouille
    // l'invariant.
    expect(source).toMatch(/from\s+['"]@\/auth\.config['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/auth['"]/);
  });
});

// Fonctionnel (VER-265) : la CSP à nonce s'ajoute SANS ouvrir ce qu'Auth.js fermait. Avec un handler, Auth.js v5 n'applique plus la
// redirection d'un `authorized()` à false : le handler la rejoue, et ces tests la gardent.
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

describe('middleware : frame-ancestors dans la CSP (26/11, la CSP bloquante remplaçait l\'en-tête de next.config.js)', () => {
  it('/login : le Hub seul ; /ia/chat : les apps aussi', async () => {
    vi.stubEnv('CSP_MODE', 'appliquer');
    const login = (await avecCsp(req('/login'))).headers.get('content-security-policy')!;
    const chat = (await avecCsp(req('/ia/chat', { id: 'u' }))).headers.get('content-security-policy')!;
    expect([/frame-ancestors 'self'(;|$)/.test(login), chat.includes("frame-ancestors 'self' https://*.app.veridian.site")]).toEqual([true, true]);
  });
});

