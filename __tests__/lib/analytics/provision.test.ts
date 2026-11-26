// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionnerAnalytics } from '@/lib/analytics/provision';

const ENV = { NODE_ENV: 'test', ANALYTICS_API_URL: 'https://analytics.test', ANALYTICS_HUB_API_SECRET: 's3cret', HMAC_V2_APPS: 'analytics' } as NodeJS.ProcessEnv;
let meta: Record<string, unknown>;
const db = {
  tenant: {
    findFirst: vi.fn(async () => ({ name: 'Org', metadata: meta })),
    update: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => { meta = data.metadata; return { id: 'T' }; }),
  },
  // La fusion par la base : seule la clé analytics est posée.
  $executeRaw: vi.fn(async (q: { values: unknown[] }) => { meta = { ...meta, ...JSON.parse(String(q.values[0])) }; return 1; }),
} as never;
const qui = { hubUserId: 'h-1', email: 'a@x.fr', name: 'A' };

beforeEach(() => { meta = { crm: { workspace_id: 'c' } }; vi.clearAllMocks(); });

// 26/11 (Analytics) : un nouveau client ne pouvait pas entrer sans site ; le Hub crée désormais l'organisation dès le provisionnement.
describe('provisionnerAnalytics', () => {
  it('crée et note l\'organisation : appel signé, par hub_user_id, et rien d\'autre de la metadata touché', async () => {
    const f = vi.fn(async (_u: string, i?: RequestInit) => {
      const h = i!.headers as Record<string, string>;
      const corps = i!.body as string;
      const attendu = createHmac('sha256', 's3cret').update([h['X-Veridian-Timestamp'], 'POST', '/api/tenants/provision', '', createHash('sha256').update(corps).digest('hex')].join('\n')).digest('hex');
      expect(h['X-Veridian-Hub-Signature']).toBe(attendu);
      expect(JSON.parse(corps)).toMatchObject({ hub_user_id: 'h-1', hub_tenant_id: 'T', organization_name: 'Org' });
      return Response.json({ organization_id: 'org-42' });
    });
    expect(await provisionnerAnalytics(db, qui, 'T', { env: ENV, fetchImpl: f as never })).toEqual({ ok: true, organizationId: 'org-42' });
    expect(meta).toMatchObject({ crm: { workspace_id: 'c' }, analytics: { workspace_id: 'org-42' } });
  });
  it('compte d\'épreuve : l\'organisation Analytics porte un nom préfixé e2e-', async () => {
    let nom: unknown;
    const f = vi.fn(async (_u: string, i?: RequestInit) => { nom = JSON.parse(i!.body as string).organization_name; return Response.json({ organization_id: 'org-42' }); });
    await provisionnerAnalytics(db, { ...qui, email: 'e2e-sso-moteur-1@veridian.site' }, 'T', { env: ENV, fetchImpl: f as never });
    expect(nom).toBe('e2e-Org');
  });
  it('route absente chez Analytics : attente nommée, rien écrit', async () => {
    const r = await provisionnerAnalytics(db, qui, 'T', { env: ENV, fetchImpl: (async () => new Response('Not Found', { status: 404 })) as never });
    expect(r).toMatchObject({ ok: false, attente: expect.stringContaining('route provision absente') });
    // Mesuré en prod le 26/11 : le 404 de Fastify pour une route inconnue est du JSON.
    const fastify = Response.json({ message: 'Route POST:/api/tenants/provision not found', error: 'Not Found', statusCode: 404 }, { status: 404 });
    expect(await provisionnerAnalytics(db, qui, 'T', { env: ENV, fetchImpl: (async () => fastify) as never })).toMatchObject({ ok: false, attente: expect.stringContaining('route provision absente') });
    // Un 404 MÉTIER (personne ou organisation inconnue) reste un refus dit.
    expect(await provisionnerAnalytics(db, qui, 'T', { env: ENV, fetchImpl: (async () => Response.json({ error: 'tenant_not_found' }, { status: 404 })) as never })).toEqual({ ok: false, error: 'analytics_404_tenant_not_found' });
    expect((db as { $executeRaw: { mock: { calls: unknown[] } } }).$executeRaw.mock.calls).toHaveLength(0);
  });
  it('refus nommé, réponse illisible, Analytics non configuré : jamais un succès', async () => {
    expect(await provisionnerAnalytics(db, qui, 'T', { env: ENV, fetchImpl: (async () => Response.json({ error: 'email_conflict' }, { status: 409 })) as never })).toEqual({ ok: false, error: 'analytics_409_email_conflict' });
    expect(await provisionnerAnalytics(db, qui, 'T', { env: ENV, fetchImpl: (async () => Response.json({ rien: 1 })) as never })).toEqual({ ok: false, error: 'analytics_reponse_illisible' });
    expect(await provisionnerAnalytics(db, qui, 'T', { env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv })).toEqual({ ok: false, error: 'analytics_not_configured' });
  });
});
