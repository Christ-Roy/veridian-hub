// @vitest-environment node
/** POST /api/cron/alerte : relais des échecs des workflows GitHub vers Loki (ligne flux=alerte), jamais critique, forme stricte. */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/cron/alerte/route';

const SECRET = 'cron-secret-de-test-0123456789';
const RUN = 'https://github.com/Christ-Roy/veridian-hub/actions/runs/46053369106';
const req = (corps: unknown, jeton: string | null = SECRET) =>
  new NextRequest('https://hub.test/api/cron/alerte', { method: 'POST', headers: jeton ? { authorization: `Bearer ${jeton}` } : {}, body: typeof corps === 'string' ? corps : JSON.stringify(corps) });
let lignes: string[] = [];
beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  lignes = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lignes.push(String(l)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/cron/alerte', () => {
  it('un échec de workflow devient une ligne flux=alerte, impact interne, avec le lien du run', async () => {
    const r = await POST(req({ evenement: 'ci.reconcile_cron', gravite: 'erreur', message: 'Reconcile tenants : échec', lien: RUN }));
    const l = JSON.parse(lignes[0]);
    expect([r.status, l.flux, l.service, l.gravite, l.impact, l.evenement, l.detail.lien]).toEqual([200, 'alerte', 'hub', 'erreur', 'interne', 'ci.reconcile_cron', RUN]);
  });
  it('mauvais jeton ou absent : 401, rien d\'écrit', async () => {
    for (const j of ['autre', null]) expect((await POST(req({ evenement: 'ci.x', gravite: 'erreur', message: 'm' }, j))).status).toBe(401);
    expect(lignes).toEqual([]);
  });
  it('jamais critique, jamais un autre lien, jamais un champ de plus : 400', async () => {
    for (const c of [
      { evenement: 'ci.x', gravite: 'critique', message: 'm' },
      { evenement: 'ci.x', gravite: 'erreur', message: 'm', lien: 'https://evil.example/runs/1' },
      { evenement: 'ci.x', gravite: 'erreur', message: 'm', impact: 'client' },
      { evenement: 'stripe.x', gravite: 'erreur', message: 'm' },
      'pas du json',
    ]) expect((await POST(req(c))).status, JSON.stringify(c)).toBe(400);
    expect(lignes).toEqual([]);
  });
  it('sans CRON_SECRET posé : 500, rien d\'écrit', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await POST(req({ evenement: 'ci.x', gravite: 'erreur', message: 'm' }))).status).toBe(500);
  });
});
