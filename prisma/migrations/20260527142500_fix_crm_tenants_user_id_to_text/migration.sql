-- Fix bug Agent A : user_id était typé UUID mais hub_app.users.id est text (cuid).
-- Convertit la colonne en TEXT et drop l'index existant pour le recréer sur le bon type.
-- Existing tenants : aucune row en prod (table jamais utilisée prod, juste 2 rows staging tests).

-- @safe: colonne user_id contient 0 rows prod et ~2 rows staging tests — drop+recreate sans risque
DROP INDEX IF EXISTS "hub_app"."crm_tenants_user_id_idx";

-- @safe: table crm_tenants jamais utilisée en prod (créée 2026-05-27, 0 rows). Cast UUID→text natif Postgres, pas de truncation possible.
ALTER TABLE "hub_app"."crm_tenants" ALTER COLUMN "user_id" TYPE TEXT USING "user_id"::text;

-- @safe: table crm_tenants 0 rows prod + ~2 rows staging. Lock exclusif inoffensif vu la taille.
CREATE INDEX "crm_tenants_user_id_idx" ON "hub_app"."crm_tenants"("user_id");
