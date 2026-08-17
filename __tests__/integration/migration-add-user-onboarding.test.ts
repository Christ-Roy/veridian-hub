/**
 * Test integration de la migration 20260817183000_add_user_onboarding.
 *
 * On ne l'exécute pas contre la DB live ici : ce test verrouille le SQL et
 * son alignement Prisma pour empêcher une table d'onboarding sans FK, sans
 * unicité userId, ou sans JSON metadata exploitable par le flow client.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260817183000_add_user_onboarding/migration.sql',
);
const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

describe('migration: add user_onboarding', () => {
  it('migration file exists', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('crée la table hub_app.user_onboarding avec les timestamps métier', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "hub_app"\."user_onboarding"/);
    expect(sql).toMatch(/"user_id" TEXT NOT NULL/);
    for (const column of [
      'invited_at',
      'activated_at',
      'first_app_started_at',
      'member_invited_at',
      'workspace_renamed_at',
      'completed_at',
    ]) {
      expect(sql).toMatch(new RegExp(`"${column}" TIMESTAMPTZ\\(6\\)`));
    }
    expect(sql).toMatch(/"metadata" JSONB/);
    expect(sql).toMatch(/"created_at" TIMESTAMPTZ\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/"updated_at" TIMESTAMPTZ\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  it('pose une primary key user_id et une FK cascade vers users', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/CONSTRAINT "user_onboarding_pkey" PRIMARY KEY \("user_id"\)/);
    expect(sql).toMatch(/CONSTRAINT "user_onboarding_user_id_fkey"/);
    expect(sql).toMatch(
      /FOREIGN KEY \("user_id"\)\s+REFERENCES "hub_app"\."users"\("id"\)\s+ON DELETE CASCADE/,
    );
  });

  it('backfill les users existants en mode idempotent', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/INSERT INTO "hub_app"\."user_onboarding"\s*\(/);
    expect(sql).toMatch(/"user_id"/);
    expect(sql).toMatch(/"activated_at"/);
    expect(sql).toMatch(/"first_app_started_at"/);
    expect(sql).toMatch(/"metadata"/);
    expect(sql).toMatch(/FROM "hub_app"\."users" u/);
    expect(sql).toMatch(/jsonb_strip_nulls\(jsonb_build_object/);
    expect(sql).toContain("'apps'");
    expect(sql).toContain("'notifuse'");
    expect(sql).toContain("'prospection'");
    expect(sql).toMatch(/ON CONFLICT \("user_id"\) DO NOTHING/);
  });

  it('le schema Prisma expose UserOnboarding et la relation 1:1 User.onboarding', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    const model = schema.match(/model UserOnboarding \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(model).toMatch(/userId\s+String\s+@id\s+@map\("user_id"\)/);
    expect(model).toMatch(/metadata\s+Json\?/);
    expect(model).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(model).toContain('@db.Timestamptz(6)');
    expect(model).toContain('@@index([activatedAt])');
    expect(model).toContain('@@map("user_onboarding")');
    expect(schema).toMatch(/onboarding\s+UserOnboarding\?/);
  });
});
