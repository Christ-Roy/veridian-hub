-- Migration v1.4 sync : ajoute `hub_app.webhook_dedup` et `hub_app.tenant_members`.
--
-- Voir prisma/schema.prisma pour les modèles correspondants :
--   - WebhookDedup : table de déduplication des webhooks app → Hub.
--     PRIMARY KEY (app, idempotency_key) garantit l'unicité par app +
--     idempotency_key fournie par l'émetteur. Fenêtre de purge 24h (via
--     cron). Stocke le payload pour audit + le received_at / processed_at
--     pour tracer l'état du dispatch.
--
--   - TenantMember : memberships cross-app — Hub source de vérité §11bis du
--     contrat. Une ligne par (tenant_id, user_id). Rôle initial = 'member'.
--     `last_known_app_role` peut diverger temporairement (sync best-effort
--     via webhooks `tenant.member_role_changed`).
--
-- Existing tenants: deux tables CREATE TABLE pures, aucun impact sur les
-- rows existantes. Aucune backfill nécessaire — TenantMember reste vide
-- jusqu'à ce que les apps émettent les premiers webhooks v1.4 ou que
-- l'accept invitation §5.22 commence à insérer des memberships. Zero
-- downtime.

-- @safe: CREATE TABLE pure, pas de modification d'objet existant
CREATE TABLE IF NOT EXISTS "hub_app"."webhook_dedup" (
    "idempotency_key" TEXT        NOT NULL,
    "app"             TEXT        NOT NULL,
    "event_type"      TEXT        NOT NULL,
    "payload"         JSONB       NOT NULL,
    "received_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"    TIMESTAMP(3),

    CONSTRAINT "webhook_dedup_pkey" PRIMARY KEY ("app", "idempotency_key")
);

-- Sert au cron de cleanup à scanner uniquement les rows non-processed
-- @safe: index partiel sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "webhook_dedup_unprocessed_received_at_idx"
    ON "hub_app"."webhook_dedup" ("received_at")
    WHERE "processed_at" IS NULL;

-- Pour purger les rows traités > 24h
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "webhook_dedup_received_at_idx"
    ON "hub_app"."webhook_dedup" ("received_at");

-- @safe: CREATE TABLE pure, pas de modification d'objet existant
CREATE TABLE IF NOT EXISTS "hub_app"."tenant_members" (
    "tenant_id"            TEXT         NOT NULL,
    "user_id"              TEXT         NOT NULL,
    "role"                 TEXT         NOT NULL DEFAULT 'member',
    "joined_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"           TIMESTAMP(3),
    "last_known_app_role"  TEXT,

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("tenant_id", "user_id")
);

-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "tenant_members_user_id_idx"
    ON "hub_app"."tenant_members" ("user_id");

-- Permet de lister rapidement les membres actifs d'un tenant
-- @safe: index partiel sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "tenant_members_active_idx"
    ON "hub_app"."tenant_members" ("tenant_id")
    WHERE "deleted_at" IS NULL;
