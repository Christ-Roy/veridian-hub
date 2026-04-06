-- ============================================================================
-- Add Stripe Schema (from Vercel template)
-- ============================================================================
-- This migration adds Stripe-specific tables while keeping our existing schema
-- Date: 2025-12-02
-- ============================================================================

-- ============================================================================
-- CUSTOMERS - Stripe customer mapping (private table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.customers (
  -- UUID from auth.users
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The user's customer ID in Stripe
  stripe_customer_id TEXT UNIQUE
);

-- Enable RLS but NO policies (private table)
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PRODUCTS - Stripe products (synced via webhooks)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.products (
  -- Product ID from Stripe, e.g. prod_1234
  id TEXT PRIMARY KEY,
  -- Whether the product is currently available for purchase
  active BOOLEAN,
  -- The product's name
  name TEXT,
  -- The product's description
  description TEXT,
  -- A URL of the product image in Stripe
  image TEXT,
  -- Additional metadata
  metadata JSONB
);

-- Enable RLS with public read-only access
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read-only access to products"
  ON public.products FOR SELECT
  USING (true);

-- ============================================================================
-- PRICES - Stripe prices (synced via webhooks)
-- ============================================================================
CREATE TYPE public.pricing_type AS ENUM ('one_time', 'recurring');
CREATE TYPE public.pricing_plan_interval AS ENUM ('day', 'week', 'month', 'year');

CREATE TABLE IF NOT EXISTS public.prices (
  -- Price ID from Stripe, e.g. price_1234
  id TEXT PRIMARY KEY,
  -- The ID of the product that this price belongs to
  product_id TEXT REFERENCES public.products(id) ON DELETE CASCADE,
  -- Whether the price can be used for new purchases
  active BOOLEAN,
  -- A brief description of the price
  description TEXT,
  -- The unit amount in smallest currency unit (e.g., 100 cents for $1.00)
  unit_amount BIGINT,
  -- Three-letter ISO currency code
  currency TEXT CHECK (char_length(currency) = 3),
  -- One of 'one_time' or 'recurring'
  type public.pricing_type,
  -- The frequency at which a subscription is billed
  interval public.pricing_plan_interval,
  -- The number of intervals between subscription billings
  interval_count INTEGER,
  -- Default number of trial days
  trial_period_days INTEGER,
  -- Additional metadata
  metadata JSONB
);

-- Enable RLS with public read-only access
ALTER TABLE public.prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read-only access to prices"
  ON public.prices FOR SELECT
  USING (true);

-- ============================================================================
-- UPDATE SUBSCRIPTIONS TABLE
-- ============================================================================
-- Add new columns from Vercel template to our existing subscriptions table

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS price_id TEXT REFERENCES public.prices(id);

-- ============================================================================
-- UPDATE PROFILES TABLE
-- ============================================================================
-- Add billing info from Vercel template to our profiles table

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS billing_address JSONB,
  ADD COLUMN IF NOT EXISTS payment_method JSONB;

-- ============================================================================
-- TRIGGER - Auto-create customer on user signup
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user_customer()
RETURNS TRIGGER AS $$
BEGIN
  -- Create customer record
  INSERT INTO public.customers (id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS on_auth_user_created_customer ON auth.users;

-- Create new trigger
CREATE TRIGGER on_auth_user_created_customer
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_customer();

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
