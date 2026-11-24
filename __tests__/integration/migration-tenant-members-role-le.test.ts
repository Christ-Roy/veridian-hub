/** Migration 20261124210000 : additive. */
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('une colonne nullable, portée par le schéma', () => {
  const sql = readFileSync('prisma/migrations/20261124210000_tenant_members_role_le/migration.sql', 'utf8').replace(/--.*$/gm, '').trim();
  expect(sql).toMatch(/^ALTER TABLE "hub_app"\."tenant_members" ADD COLUMN IF NOT EXISTS "role_le" TIMESTAMP\(3\);$/);
  expect(readFileSync('prisma/schema.prisma', 'utf8')).toMatch(/roleLe\s+DateTime\?\s+@map\("role_le"\)/);
});
