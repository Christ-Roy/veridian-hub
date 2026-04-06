-- Add lead_score column to tenants table
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0;

COMMENT ON COLUMN tenants.lead_score IS 'Lead scoring value for tracking tenant engagement (0-100)';
