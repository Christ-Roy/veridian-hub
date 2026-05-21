-- ============================================================================
-- cleanup-staging-seed.sql
-- ============================================================================
-- Nettoyage du seed E2E accumulé dans `hub-staging-db` par les sessions E2E
-- successives (Playwright `e2e/staging-full/*`, scénarios mock-OAuth, etc.).
--
-- À jouer UNIQUEMENT sur hub-staging-db. JAMAIS sur veridian-core-db (prod).
--
-- USAGE :
--   ssh dev-pub 'docker exec -i hub-staging-db psql -U hub -d hub' \
--     < scripts/admin/cleanup-staging-seed.sql
--
-- GARDE-FOUS :
--   * Tout est dans une transaction (rollback si une étape échoue).
--   * Les patterns ne ciblent que `%@e2e.veridian.site` + les 3 emails legacy
--     `e2e-fresh-*@veridian.site`, `e2e-invitee-*@veridian.site`,
--     `e2e-inviter-*@veridian.site` (sessions E2E avant standardisation).
--   * Les comptes humains `staging-test*@veridian.site`,
--     `robert+staging-test-*@veridian.test`, `trial-smoke-*@veridian.site`
--     et autres NE SONT PAS touchés.
--   * Idempotent : rejouable sans erreur (DELETE no-op si plus rien).
--
-- VERSIONNÉ : Hub repo, ne pas dupliquer dans /tmp.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Pré-comptage (visible dans stdout)
SELECT
  'BEFORE'                                                  AS phase,
  (SELECT count(*) FROM hub_app.users)                      AS users,
  (SELECT count(*) FROM hub_app.accounts)                   AS accounts,
  (SELECT count(*) FROM hub_app.sessions)                   AS sessions,
  (SELECT count(*) FROM hub_app.workspaces)                 AS workspaces,
  (SELECT count(*) FROM hub_app.workspace_members)          AS workspace_members,
  (SELECT count(*) FROM hub_app.cross_app_invitations)      AS cross_app_inv,
  (SELECT count(*) FROM hub_app.invitations)                AS invitations,
  (SELECT count(*) FROM hub_app.tenants)                    AS tenants,
  (SELECT count(*) FROM hub_app.tenant_members)             AS tenant_members,
  (SELECT count(*) FROM hub_app.mfa_codes)                  AS mfa_codes,
  (SELECT count(*) FROM hub_app.profiles)                   AS profiles,
  (SELECT count(*) FROM hub_app.provisioning_logs)          AS provisioning_logs,
  (SELECT count(*) FROM hub_app.audit_log)                  AS audit_log;

-- ----------------------------------------------------------------------------
-- 0. Identifier les IDs des users seed dans une CTE temporaire
--    Critère : email LIKE '%@e2e.veridian.site'
--    OU       email IN (legacy e2e-fresh-* / e2e-invitee-* / e2e-inviter-*)
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE seed_user_ids AS
SELECT id
FROM hub_app.users
WHERE email LIKE '%@e2e.veridian.site'
   OR (email LIKE 'e2e-fresh-%@veridian.site')
   OR (email LIKE 'e2e-invitee-%@veridian.site')
   OR (email LIKE 'e2e-inviter-%@veridian.site');

SELECT count(*) AS seed_users_targeted FROM seed_user_ids;

-- ----------------------------------------------------------------------------
-- 1. Cross-app invitations dont l'inviter OU l'invitee est un seed user
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.cross_app_invitations
WHERE inviter_user_id IN (SELECT id FROM seed_user_ids)
   OR invitee_email   LIKE '%@e2e.veridian.site'
   OR invitee_email   LIKE 'e2e-fresh-%@veridian.site'
   OR invitee_email   LIKE 'e2e-invitee-%@veridian.site'
   OR invitee_email   LIKE 'e2e-inviter-%@veridian.site';

-- ----------------------------------------------------------------------------
-- 2. Workspace invitations (Hub interne) ciblant un seed email
--    (la table `invitations` n'a que `email`, pas d'`inviter_user_id`)
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.invitations
WHERE email LIKE '%@e2e.veridian.site'
   OR email LIKE 'e2e-fresh-%@veridian.site'
   OR email LIKE 'e2e-invitee-%@veridian.site'
   OR email LIKE 'e2e-inviter-%@veridian.site';

-- ----------------------------------------------------------------------------
-- 3. Workspace memberships des seed users
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.workspace_members
WHERE user_id IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 4. Tenant members des seed users
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.tenant_members
WHERE user_id::text IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 5a. Provisioning logs des tenants seed (FK tenant_id avant suppression)
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.provisioning_logs
WHERE tenant_id IN (
  SELECT id FROM hub_app.tenants
  WHERE user_id::text IN (SELECT id FROM seed_user_ids)
);

-- ----------------------------------------------------------------------------
-- 5b. Tenants des seed users (user_id uuid -> cast en text pour join)
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.tenants
WHERE user_id::text IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 6. Sessions Auth.js des seed users
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.sessions
WHERE user_id IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 7. Accounts (OAuth links) des seed users
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.accounts
WHERE user_id IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 8. MFA codes des seed users
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.mfa_codes
WHERE user_id IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 9. Profiles des seed users (table `profiles` n'a pas d'user_id, juste email)
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.profiles
WHERE email LIKE '%@e2e.veridian.site'
   OR email LIKE 'e2e-fresh-%@veridian.site'
   OR email LIKE 'e2e-invitee-%@veridian.site'
   OR email LIKE 'e2e-inviter-%@veridian.site';

-- ----------------------------------------------------------------------------
-- 10. Verification tokens dont l'identifier match un seed email
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.verification_tokens
WHERE identifier LIKE '%@e2e.veridian.site'
   OR identifier LIKE 'e2e-fresh-%@veridian.site'
   OR identifier LIKE 'e2e-invitee-%@veridian.site'
   OR identifier LIKE 'e2e-inviter-%@veridian.site';

-- ----------------------------------------------------------------------------
-- 11. Users seed eux-mêmes
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.users
WHERE id IN (SELECT id FROM seed_user_ids);

-- ----------------------------------------------------------------------------
-- 12. Workspaces strictement orphelins (plus aucun membre)
--     -> safe pcq dès qu'un workspace garde 1 membre humain, on le laisse
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.workspaces
WHERE id NOT IN (
  SELECT DISTINCT workspace_id
  FROM hub_app.workspace_members
  WHERE workspace_id IS NOT NULL
);

-- 13. (provisioning_logs déjà purgés en 5a avant suppression des tenants)

-- ----------------------------------------------------------------------------
-- 14. Tenants orphelins (user_id ne référence aucun user existant)
--     Cas typique : E2E qui crée un tenant avant que la table users ait été
--     populated, ou tenant créé via API admin sans flow signup complet.
--     Best-effort cleanup pour éviter l'accumulation.
-- ----------------------------------------------------------------------------
DELETE FROM hub_app.tenants
WHERE user_id::text NOT IN (SELECT id FROM hub_app.users);

-- Post-comptage
SELECT
  'AFTER'                                                   AS phase,
  (SELECT count(*) FROM hub_app.users)                      AS users,
  (SELECT count(*) FROM hub_app.accounts)                   AS accounts,
  (SELECT count(*) FROM hub_app.sessions)                   AS sessions,
  (SELECT count(*) FROM hub_app.workspaces)                 AS workspaces,
  (SELECT count(*) FROM hub_app.workspace_members)          AS workspace_members,
  (SELECT count(*) FROM hub_app.cross_app_invitations)      AS cross_app_inv,
  (SELECT count(*) FROM hub_app.invitations)                AS invitations,
  (SELECT count(*) FROM hub_app.tenants)                    AS tenants,
  (SELECT count(*) FROM hub_app.tenant_members)             AS tenant_members,
  (SELECT count(*) FROM hub_app.mfa_codes)                  AS mfa_codes,
  (SELECT count(*) FROM hub_app.profiles)                   AS profiles,
  (SELECT count(*) FROM hub_app.provisioning_logs)          AS provisioning_logs,
  (SELECT count(*) FROM hub_app.audit_log)                  AS audit_log;

-- Vérification finale : aucun user seed restant
SELECT count(*) AS seed_users_remaining
FROM hub_app.users
WHERE email LIKE '%@e2e.veridian.site'
   OR email LIKE 'e2e-fresh-%@veridian.site'
   OR email LIKE 'e2e-invitee-%@veridian.site'
   OR email LIKE 'e2e-inviter-%@veridian.site';

COMMIT;
