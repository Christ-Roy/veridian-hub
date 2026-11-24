-- Délégation entre apps (VER-245 b.2) : poignées, nonces, interrupteurs et demandes. Tables neuves, rien d'existant n'est touché.
CREATE TABLE IF NOT EXISTS "hub_app"."delegation_grants" (
  "id" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "hub_user_id" TEXT NOT NULL,
  "app" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cree_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expire_le" TIMESTAMP(3) NOT NULL,
  "revoque_le" TIMESTAMP(3),
  CONSTRAINT "delegation_grants_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "delegation_grants_empreinte_key" ON "hub_app"."delegation_grants"("empreinte");
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "delegation_grants_hub_user_id_tenant_id_idx" ON "hub_app"."delegation_grants"("hub_user_id", "tenant_id");
CREATE TABLE IF NOT EXISTS "hub_app"."delegation_nonces" (
  "empreinte" TEXT NOT NULL,
  "expire_le" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delegation_nonces_pkey" PRIMARY KEY ("empreinte")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "delegation_nonces_expire_le_idx" ON "hub_app"."delegation_nonces"("expire_le");
CREATE TABLE IF NOT EXISTS "hub_app"."integration_paires" (
  "tenant_id" TEXT NOT NULL,
  "paire" TEXT NOT NULL,
  "etat" TEXT NOT NULL DEFAULT 'eteinte',
  "change_par" TEXT NOT NULL,
  "change_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consenti_par" TEXT,
  "consenti_le" TIMESTAMP(3),
  "portees" TEXT,
  "dernier_passage" TIMESTAMP(3),
  "derniere_erreur" TEXT,
  CONSTRAINT "integration_paires_pkey" PRIMARY KEY ("tenant_id", "paire")
);
CREATE TABLE IF NOT EXISTS "hub_app"."integration_demandes" (
  "empreinte" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "paire" TEXT NOT NULL,
  "demande_par" TEXT NOT NULL,
  "client_nom" TEXT NOT NULL,
  "cree_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expire_le" TIMESTAMP(3) NOT NULL,
  "confirme_le" TIMESTAMP(3),
  CONSTRAINT "integration_demandes_pkey" PRIMARY KEY ("empreinte")
);
