-- Add column to track if Notifuse invitation was sent
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS notifuse_invitation_sent_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN tenants.notifuse_invitation_sent_at IS 'Timestamp when the Notifuse workspace invitation was sent to the user';
