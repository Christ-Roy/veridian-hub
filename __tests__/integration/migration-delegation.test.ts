/** Migration 20261124220000 : seulement des tables neuves, et le schéma Prisma les porte. */
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('ne crée que des tables et leurs index', () => {
  const ordres = readFileSync('prisma/migrations/20261124220000_delegation/migration.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
  for (const o of ordres) expect(o).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS/);
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  for (const t of ['delegation_grants', 'delegation_nonces', 'integration_paires', 'integration_demandes']) expect(schema).toContain(`@@map("${t}")`);
});
