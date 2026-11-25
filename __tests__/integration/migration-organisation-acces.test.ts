/** Migration 20261125050000 : une table neuve, rien d'existant touché ; la version précédente du Hub l'ignore pendant le bleu-vert. */
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('ne fait que créer sa table et son index, et le schéma les porte', () => {
  const ordres = readFileSync('prisma/migrations/20261125050000_organisation_acces/migration.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
  expect(ordres.map((o) => o.split('(')[0].trim())).toEqual(['CREATE TABLE IF NOT EXISTS "hub_app"."organisation_acces"', 'CREATE INDEX IF NOT EXISTS "organisation_acces_hub_user_id_idx" ON "hub_app"."organisation_acces"']);
  expect(readFileSync('prisma/schema.prisma', 'utf8')).toMatch(/model OrganisationAcces \{[\s\S]*@@map\("organisation_acces"\)/);
});
