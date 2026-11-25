-- Adresses pré-inscrites par organisation (VER-227 S1). Table neuve, rien d'existant n'est touché.
CREATE TABLE IF NOT EXISTS "hub_app"."tenant_preinscriptions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "expire_le" TIMESTAMP(3) NOT NULL,
  "cree_par" TEXT NOT NULL,
  "cree_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consommee_le" TIMESTAMP(3),
  "annulee_le" TIMESTAMP(3),
  "hub_user_id" TEXT,
  CONSTRAINT "tenant_preinscriptions_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_preinscriptions_tenant_id_email_key" ON "hub_app"."tenant_preinscriptions"("tenant_id", "email");
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "tenant_preinscriptions_email_idx" ON "hub_app"."tenant_preinscriptions"("email");
