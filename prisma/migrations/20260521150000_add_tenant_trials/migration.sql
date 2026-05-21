-- Migration : trial state machine cross-app (ticket 2026-05-21-trial-state-machine).
--
-- Crée la table `hub_app.tenant_trials` et l'enum `trial_state`. Source de
-- vérité de l'état "trial" pour chaque couple (tenant_id, app).
--
-- State machine :
--   eligible          → reçue via webhook `tenant.activity_threshold_reached`
--   trial_active      → activée par le cron tick après 48h en eligible
--   trial_ending_soon → notification "expire dans 3j" envoyée à J+12
--   expired           → cron a downgrade plan=free à J+15 sans Stripe sub
--   converted         → user a ajouté CB pendant le trial → sub Stripe prend
--                       le relais, état conservé pour analytics
--
-- Existing tenants: aucun. Table neuve, vide. Pas de backfill nécessaire :
-- la state machine ne traite que les nouveaux signaux émis APRÈS le déploiement
-- du webhook receiver `tenant.activity_threshold_reached` enrichi. Zero
-- downtime. PK composite (tenant_id, app) → 1 trial par couple lifetime,
-- pas de re-trial (décision Robert 2026-05-21 §"Décisions figées").

-- @safe: CREATE TYPE pure, pas de modification d'objet existant
CREATE TYPE "hub_app"."TrialState" AS ENUM (
  'eligible',
  'trial_active',
  'trial_ending_soon',
  'expired',
  'converted'
);

-- @safe: CREATE TABLE pure, pas de modification d'objet existant
CREATE TABLE IF NOT EXISTS "hub_app"."tenant_trials" (
    "tenant_id"            TEXT                       NOT NULL,
    "app"                  TEXT                       NOT NULL,
    "state"                "hub_app"."TrialState"     NOT NULL,
    "eligible_at"          TIMESTAMPTZ(6),
    "trial_started_at"     TIMESTAMPTZ(6),
    "trial_ends_at"        TIMESTAMPTZ(6),
    "ending_soon_notified" BOOLEAN                    NOT NULL DEFAULT FALSE,
    "expired_at"           TIMESTAMPTZ(6),
    "created_at"           TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_trials_pkey" PRIMARY KEY ("tenant_id", "app")
);

-- Index global sur state — utilisé par le cron pour scanner les eligibles et
-- les trial_active à expirer/notifier.
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "tenant_trials_state_idx"
    ON "hub_app"."tenant_trials" ("state");

-- Index partiel : le cron ne scanne que les rows actives. Évite de payer le
-- coût d'un scan sur les expired/converted accumulés en historique.
-- @safe: index partiel sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "tenant_trials_active_ends_at_idx"
    ON "hub_app"."tenant_trials" ("trial_ends_at")
    WHERE "state" = 'trial_active';
