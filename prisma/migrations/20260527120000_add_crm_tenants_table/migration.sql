-- Migration : Veridian CRM tenants — table dédiée pour le provisioning Twenty.
-- Ticket : 2026-05-27-route-admin-create-crm-tenant.md
--
-- Crée `hub_app.crm_tenants` : 1 row par CRM tenant Twenty provisionné via
-- /api/admin/crm/create-tenant. La table est volontairement SÉPARÉE de
-- `hub_app.tenants` (scopée Notifuse + Prospection) car le CRM Twenty a son
-- propre cycle de vie (workspace fork AGPL, pas de plan billing Hub-side
-- pour l'instant).
--
-- Colonnes "encrypted" stockent du base64 produit par AES-256-GCM avec la clé
-- `CRM_VAULT_KEY` (ENV runtime, 32 bytes). Voir `lib/crm/vault.ts`.
--
-- Index :
--   * `user_id` → lookup "le CRM de ce user" depuis dashboard
--   * `email` UNIQUE partiel (WHERE status != 'deleted') → idempotence du POST
--     create-tenant : 2e call avec même email pour un tenant actif retourne
--     le tenant existant. Un tenant supprimé n'occupe pas le slot.
--   * `twenty_workspace_id` UNIQUE → garde-fou cohérence (1 row Hub par
--     workspace Twenty)
--   * `status` → scan rapide "tous les tenants actifs" pour cron monitoring
--
-- Compatibilité : User.id côté Hub est un cuid (text), mais tous les UUIDs
-- bridge (Tenant.userId, ici crm_tenants.user_id) référencent
-- `users.supabase_user_id` (UUID v4 stocké comme @db.Uuid). Pas de FK
-- physique vers users car la colonne cible (supabase_user_id) est
-- nullable — la FK est logique, vérifiée côté code via `userUuid()`.
--
-- Existing tenants: zero impact. CREATE TABLE pure.

-- @safe: CREATE TABLE pure, schema dédié
CREATE TABLE IF NOT EXISTS "hub_app"."crm_tenants" (
    "id"                              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "user_id"                         UUID           NOT NULL,
    "email"                           TEXT           NOT NULL,
    "workspace_display_name"          TEXT           NOT NULL,
    "twenty_workspace_id"             UUID           NOT NULL,
    "twenty_workspace_url"            TEXT           NOT NULL,
    "twenty_api_key_id"               UUID           NOT NULL,
    "twenty_api_key_encrypted"        TEXT           NOT NULL,
    "twenty_api_key_expires_at"       TIMESTAMPTZ(6) NOT NULL,
    "twenty_password_encrypted"       TEXT           NOT NULL,
    "status"                          TEXT           NOT NULL DEFAULT 'active',
    "metadata"                        JSONB,
    "provisioned_at"                  TIMESTAMPTZ(6),
    "created_at"                      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_tenants_pkey" PRIMARY KEY ("id")
);

-- Garde-fou cohérence : 1 row Hub par workspace Twenty.
-- @safe: index sur table vide
CREATE UNIQUE INDEX IF NOT EXISTS "crm_tenants_twenty_workspace_id_unique"
    ON "hub_app"."crm_tenants" ("twenty_workspace_id");

-- Lookup "le CRM de ce user" (dashboard self-service).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "crm_tenants_user_id_idx"
    ON "hub_app"."crm_tenants" ("user_id");

-- Idempotence du POST create-tenant : un email NE peut avoir QU'UN tenant
-- actif. Si un tenant est supprimé (status='deleted'), l'email se libère.
-- @safe: index UNIQUE PARTIEL sur table vide
CREATE UNIQUE INDEX IF NOT EXISTS "crm_tenants_email_active_unique"
    ON "hub_app"."crm_tenants" ("email")
    WHERE "status" != 'deleted';

-- Scan rapide pour monitoring / cron (ex: tous les actifs, tous les
-- expirés bientôt). Pas de bloat car cardinalité faible.
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "crm_tenants_status_idx"
    ON "hub_app"."crm_tenants" ("status");
