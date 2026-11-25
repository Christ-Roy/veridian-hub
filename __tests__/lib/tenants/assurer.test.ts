// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { assurerTenantHub } from '@/lib/tenants/assurer';

/** Une base où deux lectures se croisent avant l'écriture, sauf sous verrou (transaction), comme Postgres. */
function fausse(verrou: boolean) {
  const lignes: any[] = [];
  const pause = () => new Promise((ok) => setTimeout(ok, 2));
  const tenant = {
    findFirst: async ({ where }: any) => { const r = lignes.find((x) => x.userId === where.userId && !x.deletedAt) ?? null; await pause(); return r; },
    findUnique: async ({ where }: any) => lignes.find((x) => x.slug === where.slug) ?? null,
    create: async ({ data }: any) => { await pause(); const l = { id: `t${lignes.length + 1}`, ...data }; lignes.push(l); return l; },
  };
  let file: Promise<unknown> = Promise.resolve();
  const sql: string[] = [];
  const $transaction = (f: any) => { const r = file.then(() => f({ tenant, $executeRaw: async (x: TemplateStringsArray) => { sql.push(x.join('?')); } })); file = r.catch(() => undefined); return r; };
  return { db: (verrou ? { tenant, $transaction } : { tenant }) as never, lignes, sql };
}

describe('assurerTenantHub', () => {
  it('deux appels croisés pour un compte : un seul tenant ; sans le verrou, deux (l\'épreuve voit bien la course)', async () => {
    const a = fausse(true);
    const ids = await Promise.all([assurerTenantHub(a.db, 'contact@a.fr', 'u'), assurerTenantHub(a.db, 'contact@a.fr', 'u')]);
    expect([new Set(ids).size, a.lignes.length]).toEqual([1, 1]);
    expect(a.sql[0]).toMatch(/pg_advisory_xact_lock/);
    const b = fausse(false);
    await Promise.all([assurerTenantHub(b.db, 'contact@a.fr', 'u'), assurerTenantHub(b.db, 'contact@a.fr', 'u')]);
    expect(b.lignes).toHaveLength(2);
  });
  it('déjà là : rendu sans verrou ; un supprimé n\'est jamais repris ; deux comptes au même début : deux tenants', async () => {
    const a = fausse(true);
    a.lignes.push({ id: 'mort', userId: 'u', slug: 'contact', deletedAt: new Date() });
    const u = await assurerTenantHub(a.db, 'contact@a.fr', 'u');
    const v = await assurerTenantHub(a.db, 'contact@b.fr', 'v');
    expect([u === 'mort', u === v]).toEqual([false, false]);
    expect(a.sql).toHaveLength(2);
    expect(await assurerTenantHub(a.db, 'contact@a.fr', 'u')).toBe(u);
    expect(a.sql).toHaveLength(2);
  });
});
