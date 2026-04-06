-- ============================================================================
-- Global SaaS Platform - Initial Database Schema
-- ============================================================================
-- This migration creates the core tables for the Dashboard Web application
-- Date: 2025-12-02
-- ============================================================================

-- ============================================================================
-- PROFILES - User metadata (extends auth.users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  company_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- SUBSCRIPTIONS - Stripe billing management
-- ============================================================================
CREATE TYPE public.subscription_status AS ENUM (
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid'
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Stripe IDs
  stripe_customer_id TEXT UNIQUE NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,

  -- Status and dates
  status public.subscription_status NOT NULL DEFAULT 'incomplete',
  trial_end TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  canceled_at TIMESTAMPTZ,

  -- Metadata
  plan_name TEXT, -- "starter", "pro", "enterprise"
  quantity INTEGER DEFAULT 1,
  metadata JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own subscriptions"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Indexes for performance
CREATE INDEX idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer ON public.subscriptions(stripe_customer_id);
CREATE INDEX idx_subscriptions_status ON public.subscriptions(status);

-- Trigger for updated_at
CREATE TRIGGER set_updated_at_subscriptions
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- TENANTS - Twenty + Notifuse instances
-- ============================================================================
CREATE TYPE public.tenant_status AS ENUM (
  'pending',       -- Provisioning in progress
  'active',        -- Operational
  'suspended',     -- Suspended (non-payment)
  'deleted'        -- Deleted
);

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,

  -- General info
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL, -- Unique subdomain
  status public.tenant_status NOT NULL DEFAULT 'pending',

  -- Twenty CRM
  twenty_workspace_id UUID,
  twenty_subdomain TEXT,
  twenty_api_key TEXT, -- TODO: Encrypt with Vault
  twenty_user_email TEXT,
  twenty_user_password TEXT, -- TODO: Encrypt with Vault

  -- Notifuse
  notifuse_workspace_slug TEXT,
  notifuse_api_key TEXT, -- TODO: Encrypt with Vault
  notifuse_user_email TEXT,

  -- Metadata
  metadata JSONB,
  provisioned_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own tenants"
  ON public.tenants FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own tenants"
  ON public.tenants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tenants"
  ON public.tenants FOR UPDATE
  USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_tenants_user_id ON public.tenants(user_id);
CREATE INDEX idx_tenants_slug ON public.tenants(slug);
CREATE INDEX idx_tenants_status ON public.tenants(status);

-- Trigger for updated_at
CREATE TRIGGER set_updated_at_tenants
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- PROVISIONING_LOGS - Tenant provisioning logs
-- ============================================================================
CREATE TYPE public.log_level AS ENUM ('info', 'success', 'warning', 'error');

CREATE TABLE IF NOT EXISTS public.provisioning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  level public.log_level NOT NULL,
  message TEXT NOT NULL,
  service TEXT, -- 'twenty', 'notifuse', 'system'
  metadata JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.provisioning_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own tenant logs"
  ON public.provisioning_logs FOR SELECT
  USING (
    tenant_id IN (
      SELECT id FROM public.tenants WHERE user_id = auth.uid()
    )
  );

-- Indexes for performance
CREATE INDEX idx_provisioning_logs_tenant ON public.provisioning_logs(tenant_id, created_at DESC);
CREATE INDEX idx_provisioning_logs_level ON public.provisioning_logs(level);

-- ============================================================================
-- USAGE_METRICS - Usage tracking (optional)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  metric_type TEXT NOT NULL, -- 'emails_sent', 'contacts_count', 'api_calls'
  value BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,

  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.usage_metrics ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own tenant metrics"
  ON public.usage_metrics FOR SELECT
  USING (
    tenant_id IN (
      SELECT id FROM public.tenants WHERE user_id = auth.uid()
    )
  );

-- Indexes
CREATE INDEX idx_usage_metrics_tenant ON public.usage_metrics(tenant_id, metric_type, timestamp DESC);

-- ============================================================================
-- FUNCTIONS - Helper functions
-- ============================================================================

-- Function to check if user has active subscription
CREATE OR REPLACE FUNCTION public.user_has_active_subscription(user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE user_id = user_uuid
      AND status IN ('active', 'trialing')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to count user's tenants
CREATE OR REPLACE FUNCTION public.user_tenant_count(user_uuid UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM public.tenants
    WHERE user_id = user_uuid
      AND status IN ('pending', 'active')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- REALTIME - Enable realtime for specific tables
-- ============================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.tenants;
ALTER PUBLICATION supabase_realtime ADD TABLE public.provisioning_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.subscriptions;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
