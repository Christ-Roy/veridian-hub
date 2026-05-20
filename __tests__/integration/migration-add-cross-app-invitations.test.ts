/**
 * Test integration de la migration 20260520210000_add_cross_app_invitations.
 *
 * Vérifie que :
 *   1. Le fichier de migration existe et est annoté @safe.
 *   2. La table `hub_app.cross_app_invitations` est créée avec les bonnes
 *      colonnes (PK, NOT NULL, défauts, types).
 *   3. Les 4 index attendus sont présents (token unique, invitee_email,
 *      target_app+workspace, expires_at).
 *   4. Les 2 FK pointent bien vers `hub_app.users` avec ON DELETE NO ACTION
 *      (préserver l'historique d'audit).
 *   5. Le schema Prisma exporte bien le modèle `CrossAppInvitation` avec
 *      les relations inverses sur `User`.
 *
 * Ce test n'exécute PAS la migration contre une DB live. Il valide le
 * contenu pour détecter une régression (ex: quelqu'un qui modifie le
 * SQL et casse un index ou enlève une FK par accident).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260520210000_add_cross_app_invitations/migration.sql',
);
const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

describe('migration: add cross_app_invitations', () => {
  it('migration file exists', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is annotated @safe (zero-downtime, table nouvelle)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/-- @safe: CREATE TABLE pure/);
    // Chaque CREATE INDEX doit avoir son propre @safe (le check-migration-safety
    // exige l'annotation sur la ligne directement précédente).
    const safeIndexAnnotations = sql.match(
      /-- @safe: index sur table créée dans la même migration \(vide\)/g,
    );
    expect(safeIndexAnnotations).not.toBeNull();
    expect(safeIndexAnnotations!.length).toBe(4); // 1 unique + 3 secondaires
  });

  it('creates table with IF NOT EXISTS (idempotent)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "hub_app"\."cross_app_invitations"/);
  });

  describe('columns', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');

    it('has all required NOT NULL columns', () => {
      const required = [
        '"id"                    TEXT        NOT NULL',
        '"token"                 TEXT        NOT NULL',
        '"inviter_user_id"       TEXT        NOT NULL',
        '"inviter_email"         TEXT        NOT NULL',
        '"invitee_email"         TEXT        NOT NULL',
        '"target_app"            TEXT        NOT NULL',
        '"target_workspace_id"   TEXT        NOT NULL',
        '"target_role"           TEXT        NOT NULL DEFAULT \'member\'',
        '"expires_at"            TIMESTAMP(3) NOT NULL',
      ];
      for (const col of required) {
        expect(sql).toContain(col);
      }
    });

    it('has optional nullable columns', () => {
      expect(sql).toMatch(/"message"\s+TEXT,/);
      expect(sql).toMatch(/"accepted_at"\s+TIMESTAMP\(3\),/);
      expect(sql).toMatch(/"accepted_by_user_id"\s+TEXT,/);
    });

    it('defaults created_at to CURRENT_TIMESTAMP', () => {
      expect(sql).toMatch(/"created_at"\s+TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    });

    it('declares primary key on id', () => {
      expect(sql).toMatch(/CONSTRAINT "cross_app_invitations_pkey" PRIMARY KEY \("id"\)/);
    });
  });

  describe('indexes', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');

    it('has unique index on token (lookup chaud + anti-doublon)', () => {
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "cross_app_invitations_token_key"\s+ON "hub_app"\."cross_app_invitations" \("token"\)/,
      );
    });

    it('has index on invitee_email (recherche invitations en attente d\'un email)', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS "cross_app_invitations_invitee_email_idx"\s+ON "hub_app"\."cross_app_invitations" \("invitee_email"\)/,
      );
    });

    it('has composite index on (target_app, target_workspace_id) — invitations d\'un workspace', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS "cross_app_invitations_target_app_workspace_idx"\s+ON "hub_app"\."cross_app_invitations" \("target_app", "target_workspace_id"\)/,
      );
    });

    it('has index on expires_at (cron purge expirées)', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS "cross_app_invitations_expires_at_idx"\s+ON "hub_app"\."cross_app_invitations" \("expires_at"\)/,
      );
    });
  });

  describe('foreign keys', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');

    it('inviter_user_id FK to users with NO ACTION (préserver audit)', () => {
      expect(sql).toMatch(/CONSTRAINT "cross_app_invitations_inviter_user_id_fkey"/);
      expect(sql).toMatch(
        /FOREIGN KEY \("inviter_user_id"\)\s+REFERENCES "hub_app"\."users"\("id"\)\s+ON DELETE NO ACTION/,
      );
    });

    it('accepted_by_user_id FK to users with NO ACTION', () => {
      expect(sql).toMatch(/CONSTRAINT "cross_app_invitations_accepted_by_user_id_fkey"/);
      expect(sql).toMatch(
        /FOREIGN KEY \("accepted_by_user_id"\)\s+REFERENCES "hub_app"\."users"\("id"\)\s+ON DELETE NO ACTION/,
      );
    });
  });

  describe('Prisma schema alignment', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');

    it('exposes CrossAppInvitation model with @@map cross_app_invitations', () => {
      expect(schema).toMatch(/model CrossAppInvitation \{/);
      expect(schema).toMatch(/@@map\("cross_app_invitations"\)/);
    });

    it('User has inverse relations CrossAppInvitationsSent + Accepted', () => {
      expect(schema).toMatch(
        /crossAppInvitationsSent\s+CrossAppInvitation\[\] @relation\("CrossAppInvitationsSent"\)/,
      );
      expect(schema).toMatch(
        /crossAppInvitationsAccepted\s+CrossAppInvitation\[\] @relation\("CrossAppInvitationsAccepted"\)/,
      );
    });

    it('targetRole defaults to "member" (cohérent avec migration)', () => {
      expect(schema).toMatch(/targetRole\s+String\s+@default\("member"\)/);
    });

    it('token field is unique', () => {
      const modelBlock = schema.match(/model CrossAppInvitation \{[\s\S]*?\n\}/)?.[0] ?? '';
      expect(modelBlock).toMatch(/token\s+String\s+@unique/);
    });
  });
});
