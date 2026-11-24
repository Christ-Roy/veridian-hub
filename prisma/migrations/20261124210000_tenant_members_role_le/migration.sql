-- Rôle porté par le Hub (VER-245 b.1) : date du dernier changement de rôle, la version que l'app compare. Additif.
-- Existing tenants: colonne nullable ; une ligne sans valeur prend sa date d'entrée.
ALTER TABLE "hub_app"."tenant_members" ADD COLUMN IF NOT EXISTS "role_le" TIMESTAMP(3);
