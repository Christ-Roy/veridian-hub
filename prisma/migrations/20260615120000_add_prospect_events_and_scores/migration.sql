-- Migration : réconciliateur events COMPORTEMENTAUX cold↔web + scoring prospect.
-- Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
-- Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
--
-- Crée 2 tables dans `hub_app`, DISTINCTES de la réconciliation BILLING
-- (lib/sync/reconcile.ts = état tenant) :
--
--   * `prospect_events`  : 1 row par event comportemental ingéré (Notifuse :
--     email.opened/clicked/replied ; Analytics plus tard : page.hit). Dédup
--     applicative par `idempotency_key` UNIQUE (en plus de la dédup transport
--     webhook_dedup). Jointure prospect par `contact_email` au V1, `vid` en
--     étage 2 (nullable ici).
--   * `prospect_scores` : score d'engagement agrégé PAR PROSPECT, clé
--     (workspace_slug, contact_email). Distinct de tenants.lead_score (billing,
--     par tenant). Score = SUM des barèmes des events (opened +1, clicked +5,
--     replied +20, page.hit +3 — cf lib/prospect/scoring.ts).
--
-- Expand & Contract : CREATE TABLE pure, additive, idempotente. Le tag Docker
-- précédent tourne dessus sans connaître ces tables. Zéro impact sur les
-- tenants existants (aucune row créée). Aucune colonne sur une table peuplée.

-- @safe: CREATE TABLE pure, schema dédié
CREATE TABLE IF NOT EXISTS "hub_app"."prospect_events" (
    "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
    "app"              TEXT           NOT NULL,
    "event_type"       TEXT           NOT NULL,
    "vid"              TEXT,
    "workspace_slug"   TEXT           NOT NULL,
    "tenant_uuid"      UUID,
    "contact_email"    TEXT,
    "idempotency_key"  TEXT           NOT NULL,
    "occurred_at"      TIMESTAMPTZ(6) NOT NULL,
    "data"             JSONB          NOT NULL,
    "received_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_events_pkey" PRIMARY KEY ("id")
);

-- Idempotence applicative : 2e ingestion du même event = no-op (l'INSERT
-- viole l'unique, le handler avale et NE ré-incrémente PAS le score).
-- @safe: index UNIQUE sur table vide
CREATE UNIQUE INDEX IF NOT EXISTS "prospect_events_idempotency_key_unique"
    ON "hub_app"."prospect_events" ("idempotency_key");

-- Timeline d'un prospect par vid (étage 2). vid nullable au V1.
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "prospect_events_vid_occurred_at_idx"
    ON "hub_app"."prospect_events" ("vid", "occurred_at" DESC);

-- "Tous les events de type X d'un workspace" (monitoring / réconciliation).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "prospect_events_workspace_slug_event_type_idx"
    ON "hub_app"."prospect_events" ("workspace_slug", "event_type");

-- Jointure prospect par adresse mail (clé V1).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "prospect_events_contact_email_idx"
    ON "hub_app"."prospect_events" ("contact_email");

-- Lookup par tenant Hub résolu (cohérence cross-app, dashboards).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "prospect_events_tenant_uuid_idx"
    ON "hub_app"."prospect_events" ("tenant_uuid");

-- @safe: CREATE TABLE pure, schema dédié
CREATE TABLE IF NOT EXISTS "hub_app"."prospect_scores" (
    "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
    "workspace_slug"    TEXT           NOT NULL,
    "contact_email"     TEXT           NOT NULL,
    "vid"               TEXT,
    "tenant_uuid"       UUID,
    "engagement_score"  INTEGER        NOT NULL DEFAULT 0,
    "last_event_at"     TIMESTAMPTZ(6),
    "signals"           JSONB          NOT NULL DEFAULT '{}',
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_scores_pkey" PRIMARY KEY ("id")
);

-- 1 score par (workspace, prospect). Cible de l'UPSERT du handler.
-- @safe: index UNIQUE sur table vide
CREATE UNIQUE INDEX IF NOT EXISTS "prospect_scores_workspace_email_unique"
    ON "hub_app"."prospect_scores" ("workspace_slug", "contact_email");

-- "Top prospects chauds d'un workspace" (priorisation CRM).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "prospect_scores_workspace_score_idx"
    ON "hub_app"."prospect_scores" ("workspace_slug", "engagement_score" DESC);

-- Migration future vers clé par vid (étage 2).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "prospect_scores_vid_idx"
    ON "hub_app"."prospect_scores" ("vid");
