/** Fusion de metadata par la base : la requête ne porte que le patch (ou les clés à retirer), jamais le JSON entier relu avant. */
import { describe, expect, it } from 'vitest';

import { fusionnerMetadata, retirerDeMetadata } from '@/lib/tenants/metadata-fusion';

const capte = () => {
  const vus: { sql: string; values: unknown[] }[] = [];
  return { vus, db: { $executeRaw: async (q: { text: string; values: unknown[] }) => { vus.push({ sql: q.text, values: q.values }); return 1; } } as never };
};

describe('fusionnerMetadata', () => {
  it('fusionne par l\'opérateur jsonb || avec le seul patch, sur la seule organisation', async () => {
    const { vus, db } = capte();
    await fusionnerMetadata(db, '11111111-2222-4333-8444-555555555555', { hub_suspension: { cibles: { prospection: ['tp'] } } });
    expect(vus[0].sql).toMatch(/SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| \$1::jsonb/);
    expect(vus[0].values).toEqual([JSON.stringify({ hub_suspension: { cibles: { prospection: ['tp'] } } }), '11111111-2222-4333-8444-555555555555']);
  });
});
describe('retirerDeMetadata', () => {
  it('retire les seules clés nommées (jsonb - text[])', async () => {
    const { vus, db } = capte();
    await retirerDeMetadata(db, '11111111-2222-4333-8444-555555555555', ['hub_suspension']);
    expect(vus[0].sql).toMatch(/SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) - \$1::text\[\]/);
    expect(vus[0].values).toEqual([['hub_suspension'], '11111111-2222-4333-8444-555555555555']);
  });
});
