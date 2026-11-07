/**
 * Contrat : `next` (rebond) et `callbackUrl` (formulaires) refusent toute autre origine, et le rebond
 * automatique ne répond qu'à une navigation de page complète (ni iframe, ni fetch, ni préchargement).
 */
import { describe, expect, it } from 'vitest';

import { isRealNavigation, parseNext } from '@/lib/auth/bounce-next';
import { safeCallback } from '@/lib/auth/safe-callback';

const hostile = [
  'https://evil.example',
  'http://localhost:3000/dashboard',
  '//evil.example',
  '/\\evil.example',
  '\\\\evil.example',
  'javascript:alert(1)',
  'data:text/html,x',
  '/ok\n//evil.example',
  '/ok\t//evil.example',
  'evil.example',
];

describe('callbackUrl : chemin interne seulement', () => {
  it.each(hostile)('refuse %j', (raw) => {
    expect(safeCallback(raw)).toBe('/dashboard');
  });
  it('accepte un chemin du Hub, avec sa requête', () => {
    expect(safeCallback('/dashboard/billing?x=1')).toBe('/dashboard/billing?x=1');
    expect(safeCallback(null)).toBe('/dashboard');
    expect(safeCallback('/login', '/accueil')).toBe('/login');
  });
});

describe('next : sous veridian.site seulement, et jamais le Hub', () => {
  it.each([
    'https://evil.example/',
    'https://veridian.site.evil.example/',
    'https://notifuse.app.veridian.site@evil.example/',
    'https://evil.example/https://notifuse.app.veridian.site/',
    'http://notifuse.app.veridian.site/',
    'javascript:alert(1)',
    '//notifuse.app.veridian.site/',
    'https://app.veridian.site/dashboard',
    'https://hub.veridian.site/dashboard',
  ])('refuse %j en production', (raw) => {
    expect(parseNext(raw, 'production')).toBeNull();
  });

  it('la production réelle (DEPLOY_ENV=prod) refuse aussi les hôtes de staging', () => {
    expect(parseNext('https://notifuse.staging.veridian.site/x', 'prod')).toBeNull();
    expect(parseNext('https://notifuse.app.veridian.site/x', 'prod')?.app).toBe('notifuse');
  });
});

describe('isRealNavigation', () => {
  const req = (h: Record<string, string>, query = '') =>
    ({
      headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
      nextUrl: { searchParams: new URLSearchParams(query) },
    }) as never;

  it('accepte une navigation de page (et un client qui n\'envoie aucun sec-fetch)', () => {
    expect(isRealNavigation(req({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))).toBe(true);
    expect(isRealNavigation(req({}))).toBe(true);
  });

  it.each([
    ['iframe', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }],
    ['frame', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'frame' }],
    ['fetch', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
    ['fetch same-origin', { 'sec-fetch-mode': 'same-origin' }],
    ['image', { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
    ['RSC', { rsc: '1' }],
    ['prefetch du routeur', { 'next-router-prefetch': '1' }],
    ['prefetch navigateur', { purpose: 'prefetch' }],
    ['sec-purpose', { 'sec-purpose': 'prefetch;prerender' }],
  ])('refuse : %s', (_nom, h) => {
    expect(isRealNavigation(req(h as Record<string, string>))).toBe(false);
  });

  it('refuse le paramètre _rsc', () => {
    expect(isRealNavigation(req({ 'sec-fetch-mode': 'navigate' }, '_rsc=abc'))).toBe(false);
  });
});
