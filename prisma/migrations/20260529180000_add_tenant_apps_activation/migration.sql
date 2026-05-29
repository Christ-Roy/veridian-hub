-- Migration : activation d'apps gated par tenant (panneau d'admin SaaS).
-- Ticket : carte Twenty/CRM + Analytics + CMS activables par tenant via API.
--
-- Crée `hub_app.tenant_apps` : 1 row par (tenant, app gated) ACTIVÉE par
-- Robert (gestionnaire SaaS) via l'Admin API. Absence de row = app
-- DÉSACTIVÉE (défaut OFF). Ne concerne QUE les services pas grand public :
--   - 'twenty'    (CRM)
--   - 'analytics'
--   - 'cms'
-- Prospection + Notifuse restent TOUJOURS grand public, jamais gérés ici.
--
-- `user_id` = UUID bridge (cohérent avec tenants.user_id / crm_tenants.user_id,
-- qui référencent users.supabase_user_id). FK logique, vérifiée côté code via
-- userUuid() — pas de FK physique (colonne cible nullable).
--
-- Existing tenants: zero impact. CREATE TABLE pure. Toutes les apps gated
-- restent OFF par défaut pour TOUS les tenants existants (aucune row créée) —
-- ce qui est le comportement voulu : seuls Prospection/Notifuse étaient
-- réellement exposés, les autres passaient par des heuristiques metadata
-- qu'on remplace ici par un flag explicite.

-- @safe: CREATE TABLE pure, schema dédié
CREATE TABLE IF NOT EXISTS "hub_app"."tenant_apps" (
    "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
    "user_id"     UUID           NOT NULL,
    "app_key"     TEXT           NOT NULL,
    "enabled"     BOOLEAN        NOT NULL DEFAULT false,
    "enabled_at"  TIMESTAMPTZ(6),
    "enabled_by"  TEXT,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_apps_pkey" PRIMARY KEY ("id")
);

-- 1 seul flag par (tenant, app) : le toggle est idempotent (upsert).
-- @safe: index UNIQUE sur table vide
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_apps_user_id_app_key_unique"
    ON "hub_app"."tenant_apps" ("user_id", "app_key");

-- Lookup "les apps activées de ce tenant" depuis le dashboard.
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "tenant_apps_user_id_idx"
    ON "hub_app"."tenant_apps" ("user_id");
