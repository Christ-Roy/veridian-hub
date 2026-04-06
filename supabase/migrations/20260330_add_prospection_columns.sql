-- Add Prospection integration columns to tenants table
-- These columns store the connection between the hub and the prospection dashboard

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_api_key TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_login_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_login_token_used BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_login_token_created_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_plan TEXT DEFAULT 'freemium';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_config JSONB;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prospection_provisioned_at TIMESTAMPTZ;
