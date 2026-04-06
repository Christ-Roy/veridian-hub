-- Fix subscriptions table: Add missing Stripe columns
-- Date: 2025-12-09
-- Description: Add columns that Stripe webhook expects but were missing from initial schema

-- Add missing columns for Stripe webhook compatibility
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS created timestamp with time zone,
  ADD COLUMN IF NOT EXISTS ended_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS trial_start timestamp with time zone;

-- Add comment to track this fix
COMMENT ON COLUMN subscriptions.cancel_at IS 'When the subscription is scheduled to be canceled (Stripe field)';
COMMENT ON COLUMN subscriptions.created IS 'When the subscription was created in Stripe (different from created_at which is our DB timestamp)';
COMMENT ON COLUMN subscriptions.ended_at IS 'When the subscription ended (Stripe field)';
COMMENT ON COLUMN subscriptions.trial_start IS 'When the trial period started (Stripe field)';
