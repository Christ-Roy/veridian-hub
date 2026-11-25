-- SAML et fournisseur posé par le propriétaire (VER-227). Additif : les fournisseurs en place restent en OIDC, posés par un opérateur, sans alias.
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "protocole" TEXT NOT NULL DEFAULT 'oidc';
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "saml_sso_url" TEXT;
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "saml_certificat" TEXT;
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "libre_service" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "essai_le" TIMESTAMP(3);
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "alias" TEXT;
-- @safe: tenant_idps a moins de dix lignes (aucun client branché au 25/11) et la colonne vient de naître, vide : verrou instantané.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_idps_alias_key" ON "hub_app"."tenant_idps"("alias");
