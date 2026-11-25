-- Fédération OIDC par organisation (VER-227 S2). Tables neuves, rien d'existant n'est touché.
CREATE TABLE IF NOT EXISTS "hub_app"."tenant_idps" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "secret_chiffre" TEXT NOT NULL,
  "domaines" TEXT[],
  "creation_auto" BOOLEAN NOT NULL DEFAULT false,
  "actif" BOOLEAN NOT NULL DEFAULT true,
  "pose_par" TEXT NOT NULL,
  "pose_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_idps_pkey" PRIMARY KEY ("id")
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_idps_tenant_id_key" ON "hub_app"."tenant_idps"("tenant_id");
CREATE TABLE IF NOT EXISTS "hub_app"."federation_tickets" (
  "empreinte" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expire_le" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "federation_tickets_pkey" PRIMARY KEY ("empreinte")
);
