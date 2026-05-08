-- Migration : ajout des tables Workspace + Invitation (P1.5) + tables legacy
-- Supabase migrées vers hub_app (Tenant, Subscription, Product, Price, Profile,
-- ProvisioningLog, UsageMetric).
--
-- Schema additif : aucun impact sur le hub legacy qui tourne sur Supabase
-- public.* tant que la bascule blue/green n'est pas faite.

-- ============================================================================
-- Workspace + Invitation (P1.5)
-- ============================================================================

CREATE TYPE "hub_app"."WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

CREATE TABLE "hub_app"."workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hub_app"."workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "hub_app"."WorkspaceRole" NOT NULL,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMP(3),

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key"
  ON "hub_app"."workspace_members"("workspace_id", "user_id");

CREATE TABLE "hub_app"."invitations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "hub_app"."WorkspaceRole" NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_token_key" ON "hub_app"."invitations"("token");
CREATE INDEX "invitations_email_workspace_id_idx"
  ON "hub_app"."invitations"("email", "workspace_id");

ALTER TABLE "hub_app"."workspace_members"
  ADD CONSTRAINT "workspace_members_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "hub_app"."workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hub_app"."invitations"
  ADD CONSTRAINT "invitations_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "hub_app"."workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Enums legacy migrés depuis Supabase public.*
-- ============================================================================

CREATE TYPE "hub_app"."SubscriptionStatus" AS ENUM (
  'trialing', 'active', 'past_due', 'canceled',
  'incomplete', 'incomplete_expired', 'unpaid'
);

CREATE TYPE "hub_app"."TenantStatus" AS ENUM (
  'pending', 'active', 'suspended', 'deleted'
);

CREATE TYPE "hub_app"."LogLevel" AS ENUM (
  'info', 'success', 'warning', 'error'
);

CREATE TYPE "hub_app"."PricingType" AS ENUM ('one_time', 'recurring');

CREATE TYPE "hub_app"."PricingPlanInterval" AS ENUM (
  'day', 'week', 'month', 'year'
);

-- ============================================================================
-- Profile (UUID-keyed, lié au User Auth.js via supabase_user_id pour migration)
-- ============================================================================

CREATE TABLE "hub_app"."profiles" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT,
    "avatar_url" TEXT,
    "company_name" TEXT,
    "billing_address" JSONB,
    "payment_method" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "profiles_email_key" ON "hub_app"."profiles"("email");

-- ============================================================================
-- Stripe : Product, Price, Subscription
-- ============================================================================

CREATE TABLE "hub_app"."products" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN,
    "name" TEXT,
    "description" TEXT,
    "image" TEXT,
    "metadata" JSONB,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hub_app"."prices" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "active" BOOLEAN,
    "description" TEXT,
    "unit_amount" BIGINT,
    "currency" TEXT,
    "type" "hub_app"."PricingType",
    "interval" "hub_app"."PricingPlanInterval",
    "interval_count" INTEGER,
    "trial_period_days" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "prices_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "hub_app"."prices"
  ADD CONSTRAINT "prices_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "hub_app"."products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "hub_app"."subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT,
    "stripe_price_id" TEXT,
    "price_id" TEXT,
    "status" "hub_app"."SubscriptionStatus" NOT NULL DEFAULT 'incomplete',
    "trial_start" TIMESTAMPTZ(6),
    "trial_end" TIMESTAMPTZ(6),
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN DEFAULT false,
    "cancel_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created" TIMESTAMPTZ(6),
    "plan_name" TEXT,
    "quantity" INTEGER DEFAULT 1,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscriptions_stripe_customer_id_key"
  ON "hub_app"."subscriptions"("stripe_customer_id");
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key"
  ON "hub_app"."subscriptions"("stripe_subscription_id");
CREATE INDEX "subscriptions_user_id_idx" ON "hub_app"."subscriptions"("user_id");
CREATE INDEX "subscriptions_stripe_customer_id_idx"
  ON "hub_app"."subscriptions"("stripe_customer_id");
CREATE INDEX "subscriptions_status_idx" ON "hub_app"."subscriptions"("status");

ALTER TABLE "hub_app"."subscriptions"
  ADD CONSTRAINT "subscriptions_price_id_fkey"
  FOREIGN KEY ("price_id") REFERENCES "hub_app"."prices"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- ============================================================================
-- Tenants (avec toutes les colonnes accumulées au fil des migrations)
-- ============================================================================

CREATE TABLE "hub_app"."tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "subscription_id" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "hub_app"."TenantStatus" NOT NULL DEFAULT 'pending',
    "twenty_workspace_id" UUID,
    "twenty_subdomain" TEXT,
    "twenty_api_key" TEXT,
    "twenty_user_email" TEXT,
    "twenty_user_password" TEXT,
    "twenty_login_token" TEXT,
    "twenty_login_token_created_at" TIMESTAMPTZ(6),
    "notifuse_workspace_slug" TEXT,
    "notifuse_api_key" TEXT,
    "notifuse_user_email" TEXT,
    "notifuse_invitation_sent_at" TIMESTAMPTZ(6),
    "prospection_api_key" TEXT,
    "prospection_login_token" TEXT,
    "prospection_login_token_used" BOOLEAN DEFAULT false,
    "prospection_login_token_created_at" TIMESTAMPTZ(6),
    "prospection_plan" TEXT DEFAULT 'freemium',
    "prospection_config" JSONB,
    "prospection_provisioned_at" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "provisioned_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6),
    "lead_score" INTEGER DEFAULT 0,
    "trial_ends_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "cleanup_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "hub_app"."tenants"("slug");
CREATE INDEX "tenants_user_id_idx" ON "hub_app"."tenants"("user_id");
CREATE INDEX "tenants_slug_idx" ON "hub_app"."tenants"("slug");
CREATE INDEX "tenants_status_idx" ON "hub_app"."tenants"("status");
CREATE INDEX "tenants_deleted_at_idx" ON "hub_app"."tenants"("deleted_at");
CREATE INDEX "tenants_twenty_login_token_created_at_idx"
  ON "hub_app"."tenants"("twenty_login_token_created_at");

ALTER TABLE "hub_app"."tenants"
  ADD CONSTRAINT "tenants_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "hub_app"."subscriptions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- ProvisioningLog + UsageMetric
-- ============================================================================

CREATE TABLE "hub_app"."provisioning_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "level" "hub_app"."LogLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "service" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provisioning_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provisioning_logs_tenant_id_created_at_idx"
  ON "hub_app"."provisioning_logs"("tenant_id", "created_at" DESC);
CREATE INDEX "provisioning_logs_level_idx"
  ON "hub_app"."provisioning_logs"("level");

ALTER TABLE "hub_app"."provisioning_logs"
  ADD CONSTRAINT "provisioning_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "hub_app"."tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "hub_app"."usage_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "metric_type" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_metrics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_metrics_tenant_id_metric_type_timestamp_idx"
  ON "hub_app"."usage_metrics"("tenant_id", "metric_type", "timestamp" DESC);

ALTER TABLE "hub_app"."usage_metrics"
  ADD CONSTRAINT "usage_metrics_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "hub_app"."tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
