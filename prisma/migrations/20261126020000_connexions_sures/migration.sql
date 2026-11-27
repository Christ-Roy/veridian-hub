-- Connexions extérieures sûres (VER-119, VER-244). Additif : colonnes vides ou fausses par défaut, une table neuve. Une connexion IA d'avant ne voit aucun service.
ALTER TABLE "hub_app"."connecteur_clients" ADD COLUMN IF NOT EXISTS "gestion_chiffre" TEXT;
ALTER TABLE "hub_app"."connexions_externes" ADD COLUMN IF NOT EXISTS "ecriture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hub_app"."connexions_externes" ADD COLUMN IF NOT EXISTS "compte" TEXT;
ALTER TABLE "hub_app"."connexions_externes" ADD COLUMN IF NOT EXISTS "attente_chiffre" TEXT;
ALTER TABLE "hub_app"."connexions_externes" ADD COLUMN IF NOT EXISTS "attente_compte" TEXT;
ALTER TABLE "hub_app"."connexions_externes" ADD COLUMN IF NOT EXISTS "renouvellement_le" TIMESTAMP(3);
ALTER TABLE "hub_app"."oauth_codes" ADD COLUMN IF NOT EXISTS "services" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hub_app"."oauth_tokens" ADD COLUMN IF NOT EXISTS "services" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS "hub_app"."connecteur_outils_vus" (
  "connecteur" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "nom" TEXT NOT NULL,
  "definition" TEXT NOT NULL,
  "vu_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connecteur_outils_vus_pkey" PRIMARY KEY ("connecteur", "empreinte")
);
