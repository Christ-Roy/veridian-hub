-- ============================================================================
-- Migration: Add trial and cleanup columns to tenants
-- ============================================================================
-- Date: 2026-01-17
-- Purpose: Support automatic cleanup of expired Free Trial workspaces
-- ============================================================================

-- Add trial_ends_at column (set at provisioning time)
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Add deleted_at for soft delete
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Add cleanup_notified_at to track warning emails sent
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS cleanup_notified_at TIMESTAMPTZ;

-- Index for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_tenants_trial_ends_at
ON public.tenants(trial_ends_at)
WHERE status = 'active' AND deleted_at IS NULL;

-- Index for finding deleted tenants pending hard delete
CREATE INDEX IF NOT EXISTS idx_tenants_deleted_at
ON public.tenants(deleted_at)
WHERE deleted_at IS NOT NULL;

-- Set default trial_ends_at for existing active tenants (15 days from provisioned_at)
UPDATE public.tenants
SET trial_ends_at = COALESCE(provisioned_at, created_at) + INTERVAL '15 days'
WHERE trial_ends_at IS NULL
  AND status = 'active';

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
