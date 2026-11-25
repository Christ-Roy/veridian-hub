// @vitest-environment node
/** Un salarié : membre d'une organisation réglée, sans espace à lui. */
import { describe, expect, it } from 'vitest';

import { membreSeul, organisationsSeules } from '@/lib/tenants/membre-seul';

type T = { id: string; userId: string; name: string };
const base = (tenants: T[], membres: string[], orgs: { tenantId: string; type: string; nomAffiche: string | null; modules: string[] }[]) => ({
  tenantMember: { findMany: async () => membres.map((tenantId) => ({ tenantId })) },
  tenant: { findMany: async ({ where }: any) => tenants.filter((t) => t.userId === where.OR[0].userId || where.OR[1].id.in.includes(t.id)) },
  organisation: { findMany: async ({ where }: any) => orgs.filter((o) => where.tenantId.in.includes(o.tenantId) && o.type === where.type) },
}) as never;
const A = { id: 'A', userId: 'x', name: 'client' };
const SIEN = { id: 'S', userId: 'h', name: 'moi' };
const O = { tenantId: 'A', type: 'organisation', nomAffiche: 'Client', modules: ['crm'] };

describe('organisationsSeules', () => {
  it('salarié : son organisation, son nom affiché, ses apps', async () => expect(await organisationsSeules(base([A], ['A'], [O]), 'h')).toEqual([{ id: 'A', nom: 'Client', modules: ['crm'] }]));
  it('sans nom choisi : celui de l\'espace', async () => expect((await organisationsSeules(base([A], ['A'], [{ ...O, nomAffiche: null }]), 'h'))[0].nom).toBe('client'));
  it.each([
    ['un espace à lui aussi', [A, SIEN], ['A'], [O]],
    ['membre de personne', [A], [], [O]],
    ['l\'espace partagé n\'est pas une organisation réglée', [A], ['A'], [{ ...O, type: 'individuel' }]],
  ])('%s : compte ordinaire', async (_n, t, m, o) => expect(await organisationsSeules(base(t, m, o), 'h')).toEqual([]));
});
it('membreSeul', async () => expect([await membreSeul(base([A], ['A'], [O]), 'h'), await membreSeul(base([A, SIEN], ['A'], [O]), 'h')]).toEqual([true, false]));
