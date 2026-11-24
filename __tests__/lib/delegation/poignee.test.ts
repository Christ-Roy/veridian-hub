// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { emettrePoignees, empreinte, revoquerPoignees } from '@/lib/delegation/poignee';

import { base } from './fausse';

const ENV = { NODE_ENV: 'test', DELEGATION_CIBLES: 'crm' } as NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
beforeEach(() => {
  db = base();
  db.tenant.lignes.push({ id: 'A', userId: 'u', status: 'active' }, { id: 'B', userId: 'p', status: 'active' }, { id: 'S', userId: 'u', status: 'suspended' }, { id: 'X', userId: 'z', status: 'active' });
  db.tenantMember.lignes.push({ tenantId: 'B', userId: 'u', role: 'member' }, { tenantId: 'X', userId: 'u', role: 'member', deletedAt: new Date() });
});
const emettre = (app = 'prospection', env = ENV) => emettrePoignees(db as never, { hubUserId: 'u', app }, env);

describe('poignée', () => {
  it('une par organisation vivante dont il est ; le Hub n\'en garde que l\'empreinte', async () => {
    const r = await emettre();
    expect(r.map((x) => x.hub_tenant_id)).toEqual(['A', 'B']);
    for (const x of r) expect(x.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(r.map((x) => x.grant)).size).toBe(2);
    expect(JSON.stringify(db.delegationGrant.lignes)).not.toContain(r[0].grant);
    expect(db.delegationGrant.lignes[0].empreinte).toBe(empreinte(r[0].grant));
  });
  it('aucune si l\'app n\'est la source d\'aucune paire SERVIE', async () => {
    expect(await emettre('crm')).toEqual([]);
    expect(await emettre('prospection', { NODE_ENV: 'test' })).toEqual([]);
    expect(db.delegationGrant.lignes).toEqual([]);
  });
  it('crm@test : seulement les organisations d\'un compte de test', async () => {
    db.user.lignes.push({ supabaseUserId: 'u', email: 'client@x.fr' }, { supabaseUserId: 'p', email: 'e2e-sso-p@veridian.site' });
    expect((await emettre('prospection', { NODE_ENV: 'test', DELEGATION_CIBLES: 'crm@test' })).map((x) => x.hub_tenant_id)).toEqual(['B']);
  });
  it('dix vivantes au plus : la onzième révoque la plus ancienne, pas les autres', async () => {
    for (let i = 0; i < 11; i++) await emettre();
    const a = db.delegationGrant.lignes.filter((x) => x.tenantId === 'A');
    expect([a.length, a.filter((x) => x.revoqueLe).length, Boolean(a[0].revoqueLe)]).toEqual([11, 1, true]);
  });
  it('révoquer : ce compte dans ce tenant, ou tout un tenant ; jamais tout le monde', async () => {
    await emettre();
    expect(await revoquerPoignees(db as never, { hubUserId: 'u', tenantId: 'A' })).toBe(1);
    expect(await revoquerPoignees(db as never, { tenantId: 'B' })).toBe(1);
    await emettre();
    expect(await revoquerPoignees(db as never, {})).toBe(0);
  });
});
