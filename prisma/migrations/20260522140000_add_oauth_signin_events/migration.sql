-- Migration : audit log des connexions OAuth (ticket
-- 2026-05-20-oauth-rate-limiting-monitoring, phases 2-3).
--
-- Crée la table `hub_app.oauth_signin_events`. Append-only : chaque succès
-- ET chaque échec OAuth y est tracé (provider, email, ip, user_agent,
-- error_code, duration_ms). Sert la timeline admin GET /api/admin/oauth-events
-- et la détection de pics d'échecs (brute-force / provider en panne).
--
-- Existing tenants: aucun impact. Table neuve, vide — pas d'ALTER, pas de
-- backfill. La table ne commence à se remplir qu'avec les logins APRÈS le
-- déploiement du logging (event signIn + logger.error Auth.js). Zero downtime.

-- @safe: CREATE TABLE pure, pas de modification d'objet existant
CREATE TABLE IF NOT EXISTS "hub_app"."oauth_signin_events" (
    "id"          TEXT           NOT NULL,
    "event"       TEXT           NOT NULL,
    "provider"    TEXT           NOT NULL,
    "email"       TEXT,
    "ip"          TEXT,
    "user_agent"  TEXT,
    "error_code"  TEXT,
    "duration_ms" INTEGER,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_signin_events_pkey" PRIMARY KEY ("id")
);

-- Index principal : la timeline admin trie par created_at DESC.
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "oauth_signin_events_created_at_idx"
    ON "hub_app"."oauth_signin_events" ("created_at" DESC);

-- Index email : filtre admin ?email= (forensics par compte).
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "oauth_signin_events_email_idx"
    ON "hub_app"."oauth_signin_events" ("email");
