-- Durée de la session ouverte par le fournisseur d'une organisation (VER-261). Additif : vide, la règle d'avant (24 h) ne change pour personne.
ALTER TABLE "hub_app"."tenant_idps" ADD COLUMN IF NOT EXISTS "session_jours" INTEGER;
