-- Connexion d'une organisation : libre, ou obligatoire par son fournisseur (VER-261). Additif : sans ligne, rien ne change pour personne.
CREATE TABLE IF NOT EXISTS "hub_app"."tenant_connexions" (
  "tenant_id" TEXT PRIMARY KEY,
  "obligatoire" BOOLEAN NOT NULL DEFAULT false,
  "aiguillage" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "maj_par" TEXT NOT NULL,
  "maj_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "tenant_connexions_obligatoire_idx" ON "hub_app"."tenant_connexions" ("obligatoire");

CREATE TABLE IF NOT EXISTS "hub_app"."connexion_exemptions" (
  "tenant_id" TEXT NOT NULL,
  "hub_user_id" TEXT NOT NULL,
  "nature" TEXT NOT NULL,
  "pose_par" TEXT NOT NULL,
  "pose_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leve_le" TIMESTAMP(3),
  "leve_motif" TEXT,
  PRIMARY KEY ("tenant_id", "hub_user_id")
);
CREATE INDEX IF NOT EXISTS "connexion_exemptions_hub_user_id_idx" ON "hub_app"."connexion_exemptions" ("hub_user_id");

CREATE TABLE IF NOT EXISTS "hub_app"."connexion_preuves" (
  "tenant_id" TEXT NOT NULL,
  "hub_user_id" TEXT NOT NULL,
  "idp_id" TEXT NOT NULL,
  "le" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("tenant_id", "hub_user_id")
);

-- Le rôle attendu et l'accès gardé d'une personne pas encore arrivée.
ALTER TABLE "hub_app"."tenant_preinscriptions" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "hub_app"."tenant_preinscriptions" ADD COLUMN IF NOT EXISTS "exemptee" BOOLEAN NOT NULL DEFAULT false;

-- Les organisations prouvées par leur fournisseur au moment où l'accès a été donné à une IA.
ALTER TABLE "hub_app"."oauth_codes" ADD COLUMN IF NOT EXISTS "orgs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "hub_app"."oauth_tokens" ADD COLUMN IF NOT EXISTS "orgs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
