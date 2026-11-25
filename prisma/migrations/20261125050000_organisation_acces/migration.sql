-- Qui est entré dans une app réservée PAR l'organisation (décocher la retire, recocher la remet). Table neuve, rien d'existant n'est touché :
-- un membre d'avant n'y figure pas, il est « à la main », donc gardé.
CREATE TABLE IF NOT EXISTS "hub_app"."organisation_acces" (
  "tenant_id" TEXT NOT NULL,
  "app" TEXT NOT NULL,
  "hub_user_id" TEXT NOT NULL,
  "origine" TEXT NOT NULL,
  "pose_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retire_le" TIMESTAMP(3),
  "rejoint_le" TIMESTAMP(3),
  CONSTRAINT "organisation_acces_pkey" PRIMARY KEY ("tenant_id", "app", "hub_user_id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "organisation_acces_hub_user_id_idx" ON "hub_app"."organisation_acces"("hub_user_id");
