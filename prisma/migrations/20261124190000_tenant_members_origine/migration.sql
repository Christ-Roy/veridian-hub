-- Appartenance (VER-245 a) : d'où vient chaque ligne, et qui l'a posée. Additif, rien n'est réécrit.
-- Existing tenants: aucune ligne dans tenant_members au 24/11/2026 ; colonnes nullables, lecture inchangée.
ALTER TABLE "hub_app"."tenant_members" ADD COLUMN IF NOT EXISTS "origine" TEXT;
ALTER TABLE "hub_app"."tenant_members" ADD COLUMN IF NOT EXISTS "ajoute_par" TEXT;
