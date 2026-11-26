// @vitest-environment node
/** POST /api/csp : un rapport est journalisé résumé (sans query), un corps illisible ou trop gros est refusé sans rien écrire. */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/csp/route';

const appel = (corps: string) => POST(new NextRequest('https://app.veridian.site/api/csp', { method: 'POST', body: corps }));

describe('POST /api/csp', () => {
  it('journalise la violation résumée (sans query) et répond 204', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await appel(JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src-attr', 'blocked-uri': 'inline', 'document-uri': 'https://app.veridian.site/login?token=abc' } }));
    const lignes = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect([r.status, lignes.length, lignes[0].includes('[csp_violation]'), lignes[0].includes('token')]).toEqual([204, 1, true, false]);
  });
  it('corps illisible : 400, rien journalisé', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await appel('pas du json');
    const n = log.mock.calls.length;
    log.mockRestore();
    expect([r.status, n]).toEqual([400, 0]);
  });
  it('corps trop gros (plus de 64 Ko) : 413, rien journalisé', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await appel('x'.repeat(70_000));
    const n = log.mock.calls.length;
    log.mockRestore();
    expect([r.status, n]).toEqual([413, 0]);
  });
});
