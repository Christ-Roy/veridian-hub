// @vitest-environment node
/** Option A : le CRM coché pour une organisation s'ouvre à ses membres vivants, et se referme de lui-même. */
import { beforeEach, describe, expect, it } from 'vitest';

import { getEnabledGatedApps } from '@/lib/tenant-apps';
import { appsParOrganisation } from '@/lib/tenant-apps/organisation';

import { base, table } from '../delegation/fausse';

let db: any;
beforeEach(() => {
  db = { ...base(), organisation: table(), tenantApp: { findMany: async () => [] } };
  db.tenant.lignes.push({ id: 'T', userId: 'prop', status: 'active', deletedAt: null }, { id: 'V', userId: 'autre', status: 'active', deletedAt: null });
  db.organisation.lignes.push({ tenantId: 'T', modules: ['crm', 'prospection', 'academy', 'notifuse'] }, { tenantId: 'V', modules: ['crm'] });
  db.tenantMember.lignes.push({ tenantId: 'T', userId: 'm', role: 'member', deletedAt: null });
});
const de = async (u: string, t?: string) => Array.from(await appsParOrganisation(db, u, t));

describe('appsParOrganisation', () => {
  it('membre vivant et propriétaire : le CRM, et lui seul (Academy garde sa réserve) ; un étranger : rien', async () => {
    expect([await de('m'), await de('prop'), await de('etranger')]).toEqual([['twenty'], ['twenty'], []]);
  });
  it.each<[string, () => void]>([
    ['retiré', () => { db.tenantMember.lignes[0].deletedAt = new Date(); }],
    ['organisation suspendue', () => { db.tenant.lignes[0].status = 'suspended'; }],
    ['organisation supprimée', () => { db.tenant.lignes[0].deletedAt = new Date(); }],
    ['case décochée', () => { db.organisation.lignes[0].modules = ['prospection']; }],
    ['organisation jamais réglée', () => { db.organisation.lignes.length = 0; }],
    ['base illisible', () => { db.organisation.findMany = async () => { throw new Error('x'); }; }],
  ])('%s : refermé', async (_n, casser) => {
    casser();
    expect(await de('m')).toEqual([]);
  });
  it('par UNE organisation : celle de la poignée, pas une autre où elle est membre', async () => {
    expect([await de('m', 'T'), await de('m', 'V')]).toEqual([['twenty'], []]);
  });
  it('les tuiles le lisent, sans ouvrir Academy ni Analytics', async () => {
    expect(Array.from(await getEnabledGatedApps(db, 'm'))).toEqual(['twenty']);
    expect(Array.from(await getEnabledGatedApps(db, 'etranger'))).toEqual([]);
  });
});
