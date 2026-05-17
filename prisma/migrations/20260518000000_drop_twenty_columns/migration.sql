-- @safe: Twenty retiré définitivement de la stack Veridian 2026-05-18.
-- Robert (humain) a explicitement validé : "degage le sans somassion c'est des user de test".
-- 5 tenants prod avaient des refs Twenty (dernière activité 2026-04-21) — tous des comptes
-- de test. Aucune nécessité de backup data, pas de migration vers une alternative.
-- Voir cleanup discussion 2026-05-17 + reflog feat/twenty-removal.

-- DropIndex
DROP INDEX IF EXISTS "hub_app"."tenants_twenty_login_token_created_at_idx";

-- @safe: voir header migration
ALTER TABLE "hub_app"."tenants"
  DROP COLUMN IF EXISTS "twenty_workspace_id",
  DROP COLUMN IF EXISTS "twenty_subdomain",
  DROP COLUMN IF EXISTS "twenty_api_key",
  DROP COLUMN IF EXISTS "twenty_user_email",
  DROP COLUMN IF EXISTS "twenty_user_password",
  DROP COLUMN IF EXISTS "twenty_login_token",
  DROP COLUMN IF EXISTS "twenty_login_token_created_at";
