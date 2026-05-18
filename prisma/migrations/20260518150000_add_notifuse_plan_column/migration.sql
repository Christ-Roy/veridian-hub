-- Ajout colonne `notifuse_plan` typée — remplace le stockage actuel dans
-- `metadata.notifuse_plan` (JSON) pour permettre :
--  - filtres SQL natifs (`WHERE notifuse_plan = 'pro'`)
--  - index pour les vues admin/billing
--  - source de vérité claire alignée avec `prospection_plan`
--
-- Existing tenants: la colonne est NULLABLE + default 'free'. Aucune ligne ne
-- sera mise à jour automatiquement (default ne s'applique qu'aux nouvelles
-- inserts) — un backfill best-effort est exécuté en bas (COALESCE depuis
-- metadata.notifuse_plan si présent).

ALTER TABLE "hub_app"."tenants"
  ADD COLUMN IF NOT EXISTS "notifuse_plan" TEXT DEFAULT 'free';

-- Backfill depuis metadata JSON pour les tenants existants.
-- Pas de DROP du champ metadata.notifuse_plan — gardé en miroir le temps que
-- toutes les routes admin migrent sur la colonne typée.
UPDATE "hub_app"."tenants"
SET "notifuse_plan" = metadata->>'notifuse_plan'
WHERE metadata ? 'notifuse_plan'
  AND metadata->>'notifuse_plan' IS NOT NULL
  AND ("notifuse_plan" IS NULL OR "notifuse_plan" = 'free');

-- Justification de l'@safe : table `tenants` < 50 rows en prod, lock
-- exclusive < 10ms, pas de downtime perceptible.
-- @safe: CREATE INDEX sans CONCURRENTLY — table petite, lock négligeable
CREATE INDEX IF NOT EXISTS "tenants_notifuse_plan_idx"
  ON "hub_app"."tenants" ("notifuse_plan");
