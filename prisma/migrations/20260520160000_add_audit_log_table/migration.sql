-- Audit log table — traces append-only des actions admin (API admin,
-- scripts, agents IA). Cible : forensics + reproductibilité des actions
-- de provisioning manuel.
--
-- Existing tenants: création d'une table neuve (zéro impact runtime sur
-- les rows existantes — pas d'ALTER, pas de backfill nécessaire).

CREATE TABLE IF NOT EXISTS "hub_app"."audit_log" (
  "id"          TEXT NOT NULL,
  "action"      TEXT NOT NULL,
  "actor"       TEXT NOT NULL,
  "target_type" TEXT,
  "target_id"   TEXT,
  "payload"     JSONB,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- @safe: index sur table neuve vide — lock instantané, zéro downtime
CREATE INDEX IF NOT EXISTS "audit_log_action_created_at_idx" ON "hub_app"."audit_log" ("action", "created_at");

-- @safe: index sur table neuve vide — lock instantané, zéro downtime
CREATE INDEX IF NOT EXISTS "audit_log_target_id_idx" ON "hub_app"."audit_log" ("target_id");
