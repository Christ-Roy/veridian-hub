-- Existing tenants: aucun impact, colonnes nullable avec default NULL/0.
-- Met en place les colonnes de cycle de vie Notifuse (suspension, deletion,
-- usage mensuel, reset quota) + la table d'idempotence pour les webhooks
-- entrants depuis le fork Notifuse Veridian-aware.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notifuse_suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notifuse_suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS notifuse_deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notifuse_emails_sent_this_month BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifuse_quota_resets_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenants_notifuse_suspended_at
  ON tenants(notifuse_suspended_at)
  WHERE notifuse_suspended_at IS NOT NULL;

COMMENT ON COLUMN tenants.notifuse_suspended_at IS 'Set by Notifuse webhook tenant.suspended; cleared by tenant.resumed';
COMMENT ON COLUMN tenants.notifuse_suspended_reason IS 'Reason provided by Notifuse on suspension (e.g. quota exceeded)';
COMMENT ON COLUMN tenants.notifuse_deleted_at IS 'Soft delete timestamp set by Notifuse webhook tenant.deleted';
COMMENT ON COLUMN tenants.notifuse_emails_sent_this_month IS 'Counter incremented by Notifuse webhook email.sent';
COMMENT ON COLUMN tenants.notifuse_quota_resets_at IS 'Next month quota reset (informational, source of truth = Notifuse)';

-- Idempotence des webhooks Notifuse entrants
CREATE TABLE IF NOT EXISTS notifuse_events_processed (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  tenant_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifuse_events_processed_processed_at
  ON notifuse_events_processed(processed_at);

COMMENT ON TABLE notifuse_events_processed IS 'Idempotence ledger for /api/webhooks/notifuse. Purge >30j via Dokploy Schedule.';
