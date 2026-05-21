-- Migration : Stripe orchestrator central (ticket 2026-05-21-stripe-webhook-orchestrator)
--
-- Ajoute :
--   1. `hub_app.stripe_events` — table d'audit + idempotence des webhooks Stripe.
--      PK sur event_id (evt_xxx) garantit qu'un même event reçu 2 fois n'est
--      pas re-dispatché (Stripe retry à 3-30 min jusqu'à 200 reçu).
--   2. `hub_app.users.stripe_customer_id TEXT UNIQUE` — lien direct user→Stripe
--      Customer. La résolution customer→tenant passe par users.id → tenants.user_id.
--      Backfill possible depuis subscriptions.stripe_customer_id (1:1) côté
--      script admin si besoin, sinon population au signup / 1er checkout.
--
-- Existing tenants:
--   - stripe_events : nouvelle table, zéro impact sur les rows existantes,
--     aucune backfill nécessaire (l'audit commence à T+0).
--   - users.stripe_customer_id : colonne nullable ajoutée, NULL par défaut sur
--     les rows existantes. Aucune contrainte forcée NOT NULL = pas de blocage.
--     Le webhook Stripe résout déjà customer→user via `subscriptions.stripe_customer_id`
--     ou metadata Stripe (cf utils/stripe/prisma-sync.ts:resolveUserUuid),
--     donc cette nouvelle colonne est un raccourci, pas un pré-requis.
--   - Zéro downtime, zéro rewrite de table : `ADD COLUMN ... TEXT NULL` est
--     instantané sur Postgres 16.

-- @safe: CREATE TABLE pure
CREATE TABLE IF NOT EXISTS "hub_app"."stripe_events" (
    "event_id"     TEXT        NOT NULL,
    "event_type"   TEXT        NOT NULL,
    "customer_id"  TEXT,
    "payload"      JSONB       NOT NULL,
    "received_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "processed_at" TIMESTAMPTZ,
    "error"        TEXT,
    "attempts"     INT         NOT NULL DEFAULT 0,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("event_id")
);

-- Index lookup par type (dashboard MRR, debug, retry des unprocessed)
-- @safe: table neuve vide à la migration → lock instantané, 0 downtime
CREATE INDEX IF NOT EXISTS "stripe_events_event_type_idx"
    ON "hub_app"."stripe_events" ("event_type");

-- Index lookup par customer (dashboard MRR par user)
-- @safe: table neuve vide à la migration → lock instantané, 0 downtime
CREATE INDEX IF NOT EXISTS "stripe_events_customer_id_idx"
    ON "hub_app"."stripe_events" ("customer_id");

-- Index lookup des unprocessed (cron retry)
-- @safe: table neuve vide à la migration → lock instantané, 0 downtime
CREATE INDEX IF NOT EXISTS "stripe_events_processed_at_idx"
    ON "hub_app"."stripe_events" ("processed_at")
    WHERE "processed_at" IS NULL;

-- @safe: ADD COLUMN nullable (Postgres 16 = instantané, no rewrite)
ALTER TABLE "hub_app"."users"
    ADD COLUMN IF NOT EXISTS "stripe_customer_id" TEXT;

-- Unicité forte côté user (1 user = 1 customer Stripe)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_stripe_customer_id_key'
    ) THEN
        ALTER TABLE "hub_app"."users"
            ADD CONSTRAINT "users_stripe_customer_id_key" UNIQUE ("stripe_customer_id");
    END IF;
END $$;
