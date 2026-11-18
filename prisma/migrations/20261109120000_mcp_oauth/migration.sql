-- MCP Veridian (docs/CONTRAT-MCP.md) : clients IA, codes, jetons (empreintes), registre des apps.
-- Tables neuves seulement : aucun tenant existant touché.
CREATE TABLE "hub_app"."oauth_clients" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "hub_app"."oauth_clients"("client_id");

CREATE TABLE "hub_app"."oauth_codes" (
    "code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "hub_user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("code_hash")
);
CREATE INDEX "oauth_codes_expires_at_idx" ON "hub_app"."oauth_codes"("expires_at");

CREATE TABLE "hub_app"."oauth_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "hub_user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_tokens_token_hash_key" ON "hub_app"."oauth_tokens"("token_hash");
CREATE INDEX "oauth_tokens_hub_user_id_idx" ON "hub_app"."oauth_tokens"("hub_user_id");
CREATE INDEX "oauth_tokens_family_id_idx" ON "hub_app"."oauth_tokens"("family_id");
CREATE INDEX "oauth_tokens_expires_at_idx" ON "hub_app"."oauth_tokens"("expires_at");

CREATE TABLE "hub_app"."mcp_apps" (
    "app_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mcp_url" TEXT NOT NULL,
    "acces" TEXT NOT NULL DEFAULT 'tenant_app',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_apps_pkey" PRIMARY KEY ("app_key")
);
