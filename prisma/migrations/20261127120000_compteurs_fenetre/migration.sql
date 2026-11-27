-- Compteurs à fenêtre partagés entre instances (VER-270). Additif : une table neuve, vide à la création. Existing tenants: aucune ligne existante touchée ; l'ancienne version ne lit pas cette table et continue de tourner pendant la bascule.
CREATE TABLE IF NOT EXISTS "hub_app"."compteurs_fenetre" (
  "limiteur" TEXT NOT NULL,
  "cle" TEXT NOT NULL,
  "debut_ms" BIGINT NOT NULL,
  "compte" INTEGER NOT NULL,
  "expire_le" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "compteurs_fenetre_pkey" PRIMARY KEY ("limiteur", "cle", "debut_ms")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "compteurs_fenetre_expire_le_idx" ON "hub_app"."compteurs_fenetre"("expire_le");
