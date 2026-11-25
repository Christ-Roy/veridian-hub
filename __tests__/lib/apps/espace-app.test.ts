// @vitest-environment node
/** L'espace d'une app qui s'ouvre : la liaison par défaut d'une organisation neuve suit le CRM, et ne le fait jamais échouer. */
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ abonner: vi.fn() }));
vi.mock('@/lib/evenements/naissance', () => ({ abonnerParDefaut: (...a: unknown[]) => m.abonner(...a) }));

import { ensureAppWorkspace, ESPACE_APPS } from '@/lib/apps/espace-app';

const env = { CRM_API_URL: 'https://crm.test', CRM_HUB_API_SECRET: 's', ACADEMY_API_URL: 'https://a.test', ACADEMY_HUB_API_SECRET: 's' } as never;
const db = { tenant: { findFirst: async () => ({ id: 't-1' }), findUnique: async () => ({ id: 't-1', name: 'ACME', metadata: {} }), update: async () => ({}) }, tenantApp: { upsert: async () => ({}) } } as never;
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
