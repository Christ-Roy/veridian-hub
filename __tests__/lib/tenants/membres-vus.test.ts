// @vitest-environment node
import { expect, it } from 'vitest';

import { membresVus } from '@/lib/tenants/membres-vus';

const depuis = new Date('2026-11-24');
const base = (o: { hub?: string | null; tenants?: unknown[]; lignes?: unknown[] } = {}) => ({
  user: { findUnique: async () => ({ supabaseUserId: o.hub === undefined ? 'u' : o.hub }), findMany: async () => [{ supabaseUserId: 'm', email: 'm@x.fr' }] },
  tenant: { findMany: async ({ where }: any) => { expect(where).toEqual({ userId: 'u', deletedAt: null }); return o.tenants ?? [{ id: 'T', name: 'Un' }]; } },
  tenantMember: { findMany: async ({ where }: any) => { expect(where).toEqual({ tenantId: { in: ['T'] }, deletedAt: null }); return o.lignes ?? [{ tenantId: 'T', userId: 'm', role: 'member', origine: 'invitation', joinedAt: depuis }, { tenantId: 'T', userId: 'z', role: 'member', origine: null, joinedAt: depuis }]; } },
}) as never;

it('les membres de SES espaces, avec leur origine ; un compte disparu se voit quand même', async () => {
  expect(await membresVus(base(), 'c')).toEqual([
    { espace: 'Un', email: 'm@x.fr', role: 'member', origine: 'invitation', depuis },
    { espace: 'Un', email: 'compte inconnu', role: 'member', origine: null, depuis },
  ]);
});
it('sans identifiant Hub, sans espace ou sans membre : rien', async () => {
  for (const o of [{ hub: null }, { tenants: [] }, { lignes: [] }]) expect(await membresVus(base(o), 'c')).toEqual([]);
});
