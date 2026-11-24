-- Organisation réglée une fois au Hub, lue par les apps (VER-252) : marque, type, modules, et ce que chaque app a appliqué. Tables neuves.
CREATE TABLE IF NOT EXISTS "hub_app"."organisations" (
  "tenant_id" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'individuel',
  "nom_affiche" TEXT,
  "couleur_primaire" TEXT,
  "couleur_accent" TEXT,
  "logo" BYTEA,
  "logo_empreinte" TEXT,
  "modules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reglages" JSONB NOT NULL DEFAULT '{}',
  "version" BIGINT NOT NULL DEFAULT 0,
  "empreinte" TEXT,
  "maj_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "maj_par" TEXT,
  CONSTRAINT "organisations_pkey" PRIMARY KEY ("tenant_id")
);
CREATE TABLE IF NOT EXISTS "hub_app"."organisation_emissions" (
  "tenant_id" TEXT NOT NULL,
  "app" TEXT NOT NULL,
  "version" BIGINT NOT NULL,
  "etat" TEXT NOT NULL,
  "detail" TEXT,
  "le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organisation_emissions_pkey" PRIMARY KEY ("tenant_id", "app")
);
