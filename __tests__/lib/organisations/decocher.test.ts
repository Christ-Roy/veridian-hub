// @vitest-environment node
/** Décocher retire ceux venus par l'organisation, et eux seuls ; un retrait refusé se rejoue. */
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ retirer: vi.fn() }));
vi.mock('@/lib/tenants/membres', () => ({ retirerDeLApp: (...a: unknown[]) => m.retirer(...a) }));

import { retirerVenus } from '@/lib/organisations/decocher';

import { base } from './fausse';

let db: ReturnType<typeof base>;
const note = (app: string, hubUserId: string, origine = 'organisation', tenantId = 'T') => db.organisationAcces.lignes.push({ tenantId, app, hubUserId, origine, retireLe: null });
beforeEach(() => {
  db = base();
  db.tenant.lignes.push({ id: 'T', userId: 'p', status: 'active' });
  for (const x of ['p', 'u', 'v', 'w']) db.user.lignes.push({ supabaseUserId: x, email: `${x}@x.fr` });
  m.retirer.mockReset().mockImplementation(async (app: string) => ({ app, etat: 'retire' }));
  note('crm', 'u');
  note('crm', 'v', 'main');
  note('crm', 'p');
  note('academy', 'w');
  note('crm', 'u', 'organisation', 'AUTRE');
});
const decocher = (modules: string[]) => retirerVenus(db as never, 'T', modules, 'op');
const retires = () => m.retirer.mock.calls.map(([app, t, email, id]) => [app, t.id, email, id]);

it('l\'app décochée : venus par elle seulement ; ni « main », ni propriétaire, ni l\'app restée cochée, ni une autre organisation', async () => {
  expect(await decocher(['academy', 'prospection'])).toEqual([{ app: 'crm', hub_user_id: 'u', etat: 'retire' }]);
  expect(retires()).toEqual([['crm', 'T', 'u@x.fr', 'u']]);
  expect(db.auditLog.lignes[0]).toMatchObject({ action: 'organisation.decochee', targetId: 'T' });
  expect(await decocher(['academy']), 'rejoué : plus rien').toEqual([]);
  expect((await decocher([])).map((x) => [x.app, x.hub_user_id])).toEqual([['academy', 'w']]);
});
it('toutes cochées, organisation inconnue ou supprimée : rien', async () => {
  expect(await decocher(['crm', 'academy'])).toEqual([]);
  db.tenant.lignes[0].deletedAt = new Date();
  expect(await decocher([])).toEqual([]);
  expect(m.retirer).not.toHaveBeenCalled();
});
it('l\'app refuse : dit, et refait au prochain réglage ; absent : fini ; compte supprimé : fini, sans appel', async () => {
  m.retirer.mockResolvedValueOnce({ app: 'crm', etat: 'echec', detail: 'http_500' });
  expect(await decocher(['academy'])).toEqual([{ app: 'crm', hub_user_id: 'u', etat: 'echec', detail: 'http_500' }]);
  m.retirer.mockResolvedValueOnce({ app: 'crm', etat: 'absent' });
  expect(await decocher(['academy'])).toEqual([{ app: 'crm', hub_user_id: 'u', etat: 'absent' }]);
  expect(await decocher(['academy'])).toEqual([]);
  db.user.lignes.splice(db.user.lignes.findIndex((x: any) => x.supabaseUserId === 'w'), 1);
  m.retirer.mockClear();
  expect((await decocher([])).map((x) => x.etat)).toEqual(['absent']);
  expect(m.retirer).not.toHaveBeenCalled();
});
