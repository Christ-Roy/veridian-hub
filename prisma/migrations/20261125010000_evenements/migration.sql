-- Événements entre apps (VER-245, F3) : abonnements, événements reçus, liens écrits, pauses du disjoncteur. Tables neuves, rien d'existant n'est touché.
CREATE TABLE IF NOT EXISTS "hub_app"."evenement_abonnements" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "cle_externe" TEXT NOT NULL,
  "secret_chiffre" TEXT NOT NULL,
  "cree_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evenement_abonnements_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "evenement_abonnements_source_cle_externe_key" ON "hub_app"."evenement_abonnements"("source", "cle_externe");
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "evenement_abonnements_tenant_id_idx" ON "hub_app"."evenement_abonnements"("tenant_id");
CREATE TABLE IF NOT EXISTS "hub_app"."evenements_recus" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "evenement_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "cle_rfc" TEXT,
  "tenant_id" TEXT NOT NULL,
  "etat" TEXT NOT NULL DEFAULT 'pris',
  "raison" TEXT,
  "pris_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "termine_le" TIMESTAMP(3),
  CONSTRAINT "evenements_recus_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "evenements_recus_source_evenement_id_key" ON "hub_app"."evenements_recus"("source", "evenement_id");
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "evenements_recus_source_message_id_key" ON "hub_app"."evenements_recus"("source", "message_id");
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "evenements_recus_source_cle_rfc_key" ON "hub_app"."evenements_recus"("source", "cle_rfc");
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "evenements_recus_pris_le_idx" ON "hub_app"."evenements_recus"("pris_le");
CREATE TABLE IF NOT EXISTS "hub_app"."integration_liens" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "paire" TEXT NOT NULL,
  "objet_source" TEXT NOT NULL,
  "evenement_id" TEXT NOT NULL,
  "ecrit_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_liens_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "integration_liens_tenant_id_paire_objet_source_ecrit_le_idx" ON "hub_app"."integration_liens"("tenant_id", "paire", "objet_source", "ecrit_le");
CREATE TABLE IF NOT EXISTS "hub_app"."integration_pauses" (
  "tenant_id" TEXT NOT NULL,
  "paire" TEXT NOT NULL,
  "depuis_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "motif" TEXT NOT NULL,
  CONSTRAINT "integration_pauses_pkey" PRIMARY KEY ("tenant_id", "paire")
);
