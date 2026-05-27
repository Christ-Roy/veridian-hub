/**
 * Test integration de la migration 20260527142500_fix_crm_tenants_user_id_to_text.
 *
 * Contexte du bug :
 *   La migration initiale 20260527120000_add_crm_tenants_table (Agent A) a
 *   typé `crm_tenants.user_id` en UUID. MAIS `hub_app.users.id` est text
 *   (cuid via Auth.js). Résultat runtime :
 *     Invalid input value: invalid input syntax for type uuid: "cm_st_xxx"
 *   Toute lecture/insert depuis Prisma crashe en P2007, /dashboard layout
 *   crashe, bouton "Activer mon CRM" retourne 500 vide → UI "Unexpected
 *   end of JSON input".
 *
 * Ce test valide que la migration corrective :
 *   1. Existe au bon chemin
 *   2. DROP l'index existant (Postgres exige drop+recreate pour changer
 *      le type d'une colonne indexée)
 *   3. ALTER la colonne user_id en TEXT
 *   4. RECREE l'index
 *   5. Mentionne "Existing tenants:" dans le header (convention git-workflow.md)
 *   6. Le schema.prisma final ne contient PLUS `@db.Uuid` sur CrmTenant.userId
 *
 * N'exécute PAS la migration contre une DB live — c'est le rôle du job CI
 * `migrate-staging`. Ce test détecte une régression silencieuse côté SQL
 * ou schema.prisma.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260527142500_fix_crm_tenants_user_id_to_text/migration.sql',
);

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

describe('migration: fix crm_tenants.user_id UUID → TEXT', () => {
  it('migration file exists', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('drops the existing index before altering the column type', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    // Postgres refuse ALTER COLUMN TYPE sur colonne indexée. Doit drop avant.
    expect(sql).toMatch(/DROP INDEX IF EXISTS\s+"hub_app"\."crm_tenants_user_id_idx"/i);
  });

  it('alters the user_id column to TEXT with USING cast', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(
      /ALTER TABLE "hub_app"\."crm_tenants"\s+ALTER COLUMN "user_id" TYPE TEXT USING "user_id"::text/i,
    );
  });

  it('recreates the user_id index on the new TEXT column', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(
      /CREATE INDEX "crm_tenants_user_id_idx" ON "hub_app"\."crm_tenants"\("user_id"\)/i,
    );
  });

  it('documents existing tenants impact in the header (convention git-workflow.md)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql.toLowerCase()).toContain('existing tenants');
  });

  it('does NOT re-type user_id to UUID anywhere (anti-régression bug initial)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    // Strip les lignes de commentaire SQL (`-- ...`) avant le check —
    // le header documente le bug initial et mentionne "UUID" légitimement.
    const sqlNoComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    // Aucune instruction active ne doit remettre user_id en UUID
    expect(sqlNoComments).not.toMatch(/user_id.*TYPE\s+UUID/i);
    expect(sqlNoComments).not.toMatch(/user_id.*::uuid/i);
  });

  describe('schema.prisma alignment', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');

    it('CrmTenant.userId is NOT annotated @db.Uuid (anti-régression)', () => {
      // Trouve le bloc CrmTenant
      const crmTenantBlockMatch = schema.match(/model CrmTenant \{[\s\S]+?\n\}/);
      expect(crmTenantBlockMatch).not.toBeNull();
      const block = crmTenantBlockMatch![0];
      // Le champ userId doit exister
      expect(block).toMatch(/userId\s+String\s+@map\("user_id"\)/);
      // Et NE doit PAS porter @db.Uuid
      const userIdLineMatch = block.match(/userId\s+String[^\n]+/);
      expect(userIdLineMatch).not.toBeNull();
      expect(userIdLineMatch![0]).not.toContain('@db.Uuid');
    });

    it('CrmTenant.id (PK) PEUT garder @db.Uuid (c\'est correct, ce n\'est pas le bug)', () => {
      const crmTenantBlockMatch = schema.match(/model CrmTenant \{[\s\S]+?\n\}/);
      const block = crmTenantBlockMatch![0];
      // La PK reste UUID (genérée par gen_random_uuid()) — pas un bug
      expect(block).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/);
    });

    it('User.id (référencé par CrmTenant.userId) est bien String text (cuid), pas uuid', () => {
      // Garde-fou : si quelqu'un re-type User.id en uuid plus tard,
      // le mismatch revient. Ce test attrape cette régression.
      const userBlockMatch = schema.match(/^model User \{[\s\S]+?\n\}/m);
      expect(userBlockMatch).not.toBeNull();
      const block = userBlockMatch![0];
      // User.id = String avec @default(cuid()), JAMAIS @db.Uuid
      expect(block).toMatch(/^\s*id\s+String\s+@id\s+@default\(cuid\(\)\)/m);
      const idLineMatch = block.match(/^\s*id\s+String[^\n]+/m);
      expect(idLineMatch).not.toBeNull();
      expect(idLineMatch![0]).not.toContain('@db.Uuid');
    });
  });
});
