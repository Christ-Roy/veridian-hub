// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { empruntRetire, gesteRefuseEnEmprunt, PAR_CLE } from '@/lib/auth/emprunt-bornes';

const ADMIN = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
afterEach(() => vi.unstubAllEnvs());

describe('gesteRefuseEnEmprunt : la classe entière', () => {
  it('regarder passe ; sortir, se déconnecter, choisir où arriver passent', () => {
    for (const p of ['/dashboard', '/dashboard/settings', '/api/auth/bounce/complete', '/api/auth/session']) expect(gesteRefuseEnEmprunt('GET', p), p).toBe(false);
    for (const p of ['/api/auth/emprunt/sortir', '/api/auth/signout', '/api/organisations/active']) expect(gesteRefuseEnEmprunt('POST', p), p).toBe(false);
  });
  it('voisins d\'un geste permis : refusés', () => {
    for (const p of ['/api/auth/signout-autre', '/api/organisations/active2', '/api/auth/emprunt', '/api/auth/signin/google', '/api/auth/callback/credentials']) expect(gesteRefuseEnEmprunt('POST', p), p).toBe(true);
  });
  it('attacher une boîte ou un service par une lecture : refusé', () => {
    for (const p of ['/api/gmail/connect', '/api/gmail/connect/callback', '/api/connecteurs/retour']) expect(gesteRefuseEnEmprunt('GET', p), p).toBe(true);
  });
  it('toute écriture de toute route du Hub est refusée, sauf trois', () => {
    const routes: string[] = [];
    const lire = (d: string) => { for (const f of readdirSync(d)) { const p = `${d}/${f}`; if (statSync(p).isDirectory()) lire(p); else if (f === 'route.ts') routes.push(p); } };
    lire('app/api');
    const ecrivent = routes.filter((p) => /export (async function|const|function) (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(p, 'utf8'))).map((p) => `/${p.replace(/^app\//, '').replace(/\/route\.ts$/, '')}`);
    expect(ecrivent.length).toBeGreaterThan(40);
    expect(ecrivent.filter((p) => !gesteRefuseEnEmprunt('POST', p)).sort()).toEqual(['/api/auth/emprunt/sortir', '/api/organisations/active']);
  });
  it('une server action (POST sur une page) est refusée', () => expect(gesteRefuseEnEmprunt('POST', '/dashboard/ia')).toBe(true));
});

describe('empruntRetire', () => {
  it('tombe avec l\'administrateur, et jamais une session ordinaire', () => {
    vi.stubEnv('PLATFORM_ADMINS', ADMIN);
    expect(empruntRetire({ impersonated: true, impersonatedBy: ADMIN })).toBe(false);
    expect(empruntRetire({ impersonated: true, impersonatedBy: PAR_CLE })).toBe(false);
    for (const par of ['admin', undefined, '11111111-2222-4333-8444-555555555555']) expect(empruntRetire({ impersonated: true, impersonatedBy: par })).toBe(true);
    expect(empruntRetire({ impersonatedBy: 'admin' })).toBe(false);
  });
});
