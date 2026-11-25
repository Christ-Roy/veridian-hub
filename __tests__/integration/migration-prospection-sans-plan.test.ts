/** Migration 20261126030000 : seul le défaut de la colonne disparaît ; aucune ligne n'est réécrite, la version précédente du Hub pose encore le sien pendant le bleu-vert. */
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('ne retire que la valeur par défaut, et le schéma n\'en a plus', () => {
  const ordres = readFileSync('prisma/migrations/20261126030000_prospection_sans_plan_par_defaut/migration.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
  expect(ordres).toEqual(['ALTER TABLE "hub_app"."tenants" ALTER COLUMN "prospection_plan" DROP DEFAULT']);
  expect(readFileSync('prisma/schema.prisma', 'utf8')).toMatch(/prospectionPlan +String\? +@map\("prospection_plan"\)/);
});
