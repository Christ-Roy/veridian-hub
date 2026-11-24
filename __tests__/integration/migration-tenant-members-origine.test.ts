/** Migration 20261124190000 : additive, la version précédente du Hub lit pendant le bleu-vert. */
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const sql = readFileSync('prisma/migrations/20261124190000_tenant_members_origine/migration.sql', 'utf8');
const schema = readFileSync('prisma/schema.prisma', 'utf8');

it('n\'ajoute que des colonnes nullables, et le schéma les porte', () => {
  const ordres = sql.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
  expect(ordres).toHaveLength(2);
  for (const o of ordres) {
    expect(o).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(o).not.toMatch(/NOT NULL|DROP|RENAME|DEFAULT/i);
  }
  expect(schema).toMatch(/origine\s+String\?/);
  expect(schema).toMatch(/ajoutePar\s+String\?\s+@map\("ajoute_par"\)/);
});
