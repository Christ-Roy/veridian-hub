// @vitest-environment node
/** L'espace d'une app qui s'ouvre : la liaison par défaut d'une organisation neuve suit le CRM, et ne le fait jamais échouer. */
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ abonner: vi.fn() }));
vi.mock('@/lib/evenements/naissance', () => ({ abonnerParDefaut: (...a: unknown[]) => m.abonner(...a) }));

import { ensureAppWorkspace, ESPACE_APPS } from '@/lib/apps/espace-app';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

const env = { CRM_API_URL: 'https://crm.test', CRM_HUB_API_SECRET: 's', ACADEMY_API_URL: 'https://a.test', ACADEMY_HUB_API_SECRET: 's' } as never;
const db = { tenant: { findFirst: async () => ({ id: 't-1' }), findUnique: async () => ({ id: 't-1', name: 'ACME', metadata: {} }), update: async () => ({}) }, tenantApp: { upsert: async () => ({}) }, $executeRaw: async () => 1 } as never;
const ouvrir = (cle: 'crm' | 'academy', statut = 200) => ensureAppWorkspace(ESPACE_APPS[cle], db, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl: (async () => new Response(JSON.stringify({ workspace_id: 'ws', created: true }), { status: statut })) as never });
beforeEach(() => { vi.clearAllMocks(); m.abonner.mockResolvedValue('sans_objet'); });

it('le CRM ouvert : son organisation est vue, une fois', async () => {
  expect((await ouvrir('crm')).ok).toBe(true);
  expect(m.abonner.mock.calls.map((c) => c[1])).toEqual(['t-1']);
});
it('une autre app, ou un CRM qui refuse : rien', async () => {
  await ouvrir('academy');
  expect((await ouvrir('crm', 502)).ok).toBe(false);
  expect(m.abonner).not.toHaveBeenCalled();
});

it('signature : le POST d\'ouverture part en v2 quand HMAC_V2_APPS nomme l\'app, en v1 sinon', async () => {
  const vus: { url: string; h: Record<string, string>; corps: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    vus.push({ url, h: init.headers as Record<string, string>, corps: String(init.body) });
    return new Response(JSON.stringify({ workspace_id: 'ws', created: true }), { status: 200 });
  }) as never;
  vi.stubEnv('HMAC_V2_APPS', 'crm');
  try {
    await ensureAppWorkspace(ESPACE_APPS.crm, db, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl: f });
    await ensureAppWorkspace(ESPACE_APPS.academy, db, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl: f });
  } finally {
    vi.unstubAllEnvs();
  }
  const [crmCall, academieCall] = vus;
  exigeV2(crmCall.h, 's', 'POST', crmCall.url, crmCall.corps);
  exigeV1(academieCall.h, 's', academieCall.corps);
});

it('compte d\'épreuve : Academy et le CRM reçoivent un nom d\'espace préfixé e2e-, un client garde « ACME »', async () => {
  const noms: string[] = [];
  const f = (async (_u: string, init: RequestInit) => { noms.push(JSON.parse(String(init.body)).workspace_name); return new Response(JSON.stringify({ workspace_id: 'ws', created: true }), { status: 200 }); }) as never;
  await ensureAppWorkspace(ESPACE_APPS.academy, db, { hubUserId: 'h', email: 'e2e-sso-moteur-1@veridian.site' }, { env, fetchImpl: f });
  await ensureAppWorkspace(ESPACE_APPS.crm, db, { hubUserId: 'h', email: 'e2e-sso-moteur-1@veridian.site' }, { env, fetchImpl: f });
  await ensureAppWorkspace(ESPACE_APPS.crm, db, { hubUserId: 'h', email: 'a@x.io' }, { env, fetchImpl: f });
  expect(noms).toEqual(['e2e-ACME', 'e2e-ACME', 'ACME']);
});

