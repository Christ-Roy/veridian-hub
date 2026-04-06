-- ============================================================================
-- Add login token columns for magic link management
-- ============================================================================
-- Date: 2025-12-15
-- Purpose: Store Twenty loginToken to avoid regenerating if still valid (<15min)
-- ============================================================================

-- Add columns to store Twenty loginToken
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS twenty_login_token TEXT,
  ADD COLUMN IF NOT EXISTS twenty_login_token_created_at TIMESTAMPTZ;

-- Add index for performance (checking token expiration)
CREATE INDEX IF NOT EXISTS idx_tenants_twenty_login_token_created
  ON public.tenants(twenty_login_token_created_at);

-- Add comment
COMMENT ON COLUMN public.tenants.twenty_login_token IS 'Twenty CRM loginToken for magic links (expires in 15min)';
COMMENT ON COLUMN public.tenants.twenty_login_token_created_at IS 'Timestamp when loginToken was generated';
