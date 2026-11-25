-- Connexions d'une personne à des services extérieurs (VER-119, VER-244) : tables neuves, rien d'existant ne change.
CREATE TABLE IF NOT EXISTS "hub_app"."connecteur_clients" (
  "connecteur" TEXT NOT NULL,
  "retour" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "secret_chiffre" TEXT,
  "cree_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connecteur_clients_pkey" PRIMARY KEY ("connecteur", "retour")
);
CREATE TABLE IF NOT EXISTS "hub_app"."connexions_externes" (
  "id" TEXT NOT NULL,
  "hub_user_id" TEXT NOT NULL,
  "connecteur" TEXT NOT NULL,
  "acces_chiffre" TEXT NOT NULL,
  "refresh_chiffre" TEXT,
  "expire_le" TIMESTAMP(3),
  "etat" TEXT NOT NULL DEFAULT 'active',
  "cree_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "renouvele_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connexions_externes_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "connexions_externes_hub_user_id_connecteur_key" ON "hub_app"."connexions_externes"("hub_user_id", "connecteur");
