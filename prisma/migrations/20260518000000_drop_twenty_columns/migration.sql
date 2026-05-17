-- Twenty retiré définitivement de la stack Veridian 2026-05-18.
-- Robert (humain) a explicitement validé : "degage le sans somassion c'est des user de test".
-- 5 tenants prod avaient des refs Twenty (dernière activité 2026-04-21) — tous des comptes
-- de test. Aucune nécessité de backup data, pas de migration vers une alternative.
-- Voir commit feat(hub): remove Twenty from stack pour le contexte complet.

-- @safe: index twenty_login_token_created_at_idx — recréable, associé à colonnes droppées juste après
DROP INDEX IF EXISTS "hub_app"."tenants_twenty_login_token_created_at_idx";

-- @safe: colonnes legacy twenty_workspace_id — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_workspace_id";

-- @safe: colonnes legacy twenty_subdomain — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_subdomain";

-- @safe: colonnes legacy twenty_api_key — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_api_key";

-- @safe: colonnes legacy twenty_user_email — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_user_email";

-- @safe: colonnes legacy twenty_user_password — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_user_password";

-- @safe: colonnes legacy twenty_login_token — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_login_token";

-- @safe: colonnes legacy twenty_login_token_created_at — Twenty retiré, 5 tenants test seulement (validé Robert)
ALTER TABLE "hub_app"."tenants" DROP COLUMN IF EXISTS "twenty_login_token_created_at";
