/**
 * Test integration de la migration 20260518000000_drop_twenty_columns.
 *
 * Vérifie que :
 *   1. Le fichier de migration existe et est marqué @safe.
 *   2. Il DROP les 7 colonnes twenty_* attendues.
 *   3. Il DROP l'index twenty_login_token_created_at_idx.
 *
 * Ce test n'exécute PAS la migration contre une DB live (ça c'est le rôle
 * du job CI `migrate-staging`). Il valide juste le contenu SQL pour qu'on
 * détecte une régression silencieuse (ex: quelqu'un qui rajoute une colonne
 * twenty_* par accident via prisma migrate dev).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260518000000_drop_twenty_columns/migration.sql',
);

describe('migration: drop twenty columns', () => {
  it('migration file exists', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is annotated @safe with reason', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/-- @safe:/);
    expect(sql).toMatch(/Twenty retiré/i);
  });

  it('drops all 7 twenty_* columns', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    const expected = [
      'twenty_workspace_id',
      'twenty_subdomain',
      'twenty_api_key',
      'twenty_user_email',
      'twenty_user_password',
      'twenty_login_token',
      'twenty_login_token_created_at',
    ];
    for (const col of expected) {
      expect(sql).toContain(`DROP COLUMN IF EXISTS "${col}"`);
    }
  });

  it('drops the twenty_login_token_created_at index', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/DROP INDEX IF EXISTS .*twenty_login_token_created_at/i);
  });
});
