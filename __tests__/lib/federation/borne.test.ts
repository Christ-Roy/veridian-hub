// @vitest-environment node
/** Une session fédérée n'ouvre qu'une organisation : être d'ailleurs aussi la refuse, et la fait tomber si elle vit. */
import { describe, expect, it, vi } from 'vitest';

import { horsDeSaBorne, seulementIci } from '@/lib/federation/borne';

type T = { id: string; userId: string; deletedAt: Date | null };
const base = (tenants: T[], membres: string[]) => ({
  user: { findUnique: async ({ where }: any) => (where.id === 'U' ? { supabaseUserId: 'h' } : null) },
  tenantMember: { findMany: async () => membres.map((tenantId) => ({ tenantId })) },
  tenant: { findMany: async ({ where }: any) => tenants.filter((t) => !t.deletedAt && (t.userId === where.OR[0].userId || where.OR[1].id.in.includes(t.id))).map(({ id }) => ({ id })) },
}) as never;
const t = (id: string, userId = 'x', deletedAt: Date | null = null): T => ({ id, userId, deletedAt });
const J = { federe: true, federeOrg: 'A', uid: 'U' };

describe('seulementIci', () => {
  it.each([
    ['membre de celle-ci seule', [t('A'), t('B')], ['A'], true],
    ['propriétaire de celle-ci seule', [t('A', 'h')], [], true],
    ['membre de deux', [t('A'), t('B')], ['A', 'B'], false],
    ['membre de celle-ci, et son propre espace', [t('A'), t('S', 'h')], ['A'], false],
    ['membre d\'une autre seulement', [t('B')], ['B'], false],
    ['l\'autre est supprimée', [t('A'), t('B', 'x', new Date())], ['A', 'B'], true],
    ['celle-ci est supprimée', [t('A', 'x', new Date())], ['A'], false],
    ['de nulle part', [], [], false],
  ])('%s', async (_n, tenants, membres, attendu) => expect(await seulementIci(base(tenants as T[], membres as string[]), 'h', 'A')).toBe(attendu));
});

describe('horsDeSaBorne', () => {
  const une = base([t('A')], ['A']);
  it('une session ordinaire n\'est jamais bornée, même de deux organisations', async () => expect(await horsDeSaBorne(base([t('A'), t('B')], ['A', 'B']), { uid: 'U' })).toBe(false));
  it('fédérée et d\'ici seulement : elle vit ; d\'ailleurs aussi : elle tombe', async () => {
    expect([await horsDeSaBorne(une, J), await horsDeSaBorne(base([t('A'), t('B')], ['A', 'B']), J)]).toEqual([false, true]);
  });
  it('sans organisation, sans compte, ou illisible : elle tombe', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const casse = { user: { findUnique: async () => { throw new Error('base'); } } } as never;
    expect([await horsDeSaBorne(une, { federe: true, uid: 'U' }), await horsDeSaBorne(une, { ...J, uid: 'V' }), await horsDeSaBorne(une, { ...J, uid: undefined }), await horsDeSaBorne(casse, J)]).toEqual([true, true, true, true]);
  });
});
