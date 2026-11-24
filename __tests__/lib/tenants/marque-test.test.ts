// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { DUREE_MARQUE_H, estDeTest, marquerTest } from '@/lib/tenants/marque-test';

import { base } from '../delegation/fausse';

let db: ReturnType<typeof base>;
const dans = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
beforeEach(() => {
  db = base();
  db.tenant.lignes.push({ id: 'T', userId: 't', metadata: { crm: { workspace_id: 'w' } } }, { id: 'C', userId: 'c', metadata: null });
  db.user.lignes.push({ supabaseUserId: 't', email: 'e2e-sso-x@veridian.site' }, { supabaseUserId: 'c', email: 'client@x.fr' });
});
const marquer = (tenantId: string, poser = true) => marquerTest(db as never, { tenantId, poser, acteur: 'token:T' });

describe('estDeTest', () => {
  it('seulement une marque vivante, 24 h au plus : rien, passée, trop longue ou illisible ne valent rien', () => {
    const m = (expire_le: unknown) => estDeTest({ organisation_de_test: { expire_le } });
    expect([m(dans(1)), m(dans(DUREE_MARQUE_H - 0.01)), m(dans(-0.01)), m(dans(DUREE_MARQUE_H + 1)), m('toujours'), m(null), m(9e15)]).toEqual([true, true, false, false, false, false, false]);
    expect([estDeTest(null), estDeTest(undefined), estDeTest({}), estDeTest({ organisation_de_test: true })]).toEqual([false, false, false, false]);
  });
});

describe('marquerTest', () => {
  it('une adresse de batterie ne suffit pas : c\'est la marque qui ouvre ; retirée, plus rien ; le reste des métadonnées est gardé', async () => {
    expect(estDeTest(db.tenant.lignes[0].metadata), 'adresse ressemblante, non marquée').toBe(false);
    expect(await marquer('T')).toEqual({ expire_le: expect.any(String) });
    expect([estDeTest(db.tenant.lignes[0].metadata), db.tenant.lignes[0].metadata.crm]).toEqual([true, { workspace_id: 'w' }]);
    expect(await marquer('T', false)).toEqual({ expire_le: null });
    expect(db.tenant.lignes[0].metadata).toEqual({ crm: { workspace_id: 'w' } });
    expect(db.auditLog.lignes.map((x) => x.action)).toEqual(['tenant.test_marque', 'tenant.test_retire']);
  });
  it('un vrai client ne se marque pas ; un tenant inconnu non plus', async () => {
    expect(await marquer('C')).toEqual({ refus: 'compte_reel' });
    expect(await marquer('Z')).toEqual({ refus: 'tenant_introuvable' });
    expect(db.tenant.lignes[1].metadata).toBeNull();
    expect(db.auditLog.lignes).toEqual([]);
  });
});
