// @vitest-environment node
/** POST /api/csp : un rapport est journalisé résumé (sans query), un corps illisible ou trop gros est refusé sans rien écrire. */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/csp/route';

const appel = (corps: string) => POST(new NextRequest('https://app.veridian.site/api/csp', { method: 'POST', body: corps }));

describe('POST /api/csp', () => {
  it('journalise la violation résumée et répond 204 ; corps illisible 400, trop gros 413, rien journalisé', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await appel(JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src-attr', 'blocked-uri': 'inline', 'document-uri': 'https://app.veridian.site/login?token=abc' } }));
    const lignes = log.mock.calls.map((c) => String(c[0]));
    const mauvais = [(await appel('pas du json')).status, (await appel('x'.repeat(70_000))).status];
    expect([ok.status, lignes.length, lignes[0].includes('[csp_violation]'), lignes[0].includes('token'), mauvais, log.mock.calls.length]).toEqual([204, 1, true, false, [400, 413], 1]);
    log.mockRestore();
  });
});
