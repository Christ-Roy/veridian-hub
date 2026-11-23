-- « Mon IA » (docs/MON-IA.md) : branchements (clés scellées), interrupteurs, sessions liées au tenant.
-- Tables neuves seulement : aucun tenant existant touché.
CREATE TABLE "hub_app"."ia_branchements" (
    "id" UUID NOT NULL,
    "hub_user_id" TEXT NOT NULL,
    "moteur" TEXT NOT NULL DEFAULT 'cle-api',
    "fournisseur" TEXT NOT NULL,
    "modele" TEXT NOT NULL,
    "cle_scellee" TEXT NOT NULL,
    "cle_empreinte" TEXT NOT NULL,
    "cle_fin" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ia_branchements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ia_branchements_hub_user_id_fournisseur_key" ON "hub_app"."ia_branchements"("hub_user_id", "fournisseur");

CREATE TABLE "hub_app"."ia_activations" (
    "hub_user_id" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ia_activations_pkey" PRIMARY KEY ("hub_user_id", "app", "tenant_id")
);

CREATE TABLE "hub_app"."ia_sessions" (
    "id" UUID NOT NULL,
    "hub_user_id" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "moteur" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ia_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ia_sessions_hub_user_id_app_tenant_id_idx" ON "hub_app"."ia_sessions"("hub_user_id", "app", "tenant_id");
