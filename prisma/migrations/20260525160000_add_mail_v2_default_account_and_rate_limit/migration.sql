-- Migration : Mail Gateway v2 — multi-comptes default + rate-limit per-recipient.
-- Ticket : 2026-05-25-mail-provider-status-endpoint.md
--
-- 1. Ajoute `accounts.is_default_for_mail BOOLEAN DEFAULT false` : marquer
--    UN compte comme défaut pour les envois `send-as-user` sans
--    `mail_account_id` explicite. Index UNIQUE partiel WHERE = true
--    garantit qu'au plus UN Account par user porte la valeur true.
--
-- 2. Crée `hub_app.mail_recipient_rate_limit` : 1 row par destinataire
--    quel que soit le user/app caller (rate-limit GLOBAL Hub-side,
--    voulu Robert 2026-05-25 — 1 mail max / 20 min / email destinataire).
--    Storage déterministe (UPSERT) — on garde le dernier sender + caller
--    pour forensics.
--
-- 3. Crée `hub_app.mail_rate_limit_events` : append-only audit chaque
--    fois qu'un envoi est bloqué (429 / 207 multi-status). Indexable
--    pour endpoint /api/admin/mail-rate-limit/stats.
--
-- Existing tenants: zero impact runtime.
--   * ADD COLUMN avec défaut booléen — pas de rewrite (PG ≥ 11).
--   * Index unique partiel (WHERE is_default_for_mail = true) construit
--     instantanément sur tenants existants (aucune row matche → vide).
--   * 2 nouvelles tables vides — CREATE TABLE pure.

-- @safe: ADD COLUMN avec défaut booléen — pas de rewrite
ALTER TABLE "hub_app"."accounts"
    ADD COLUMN IF NOT EXISTS "is_default_for_mail" BOOLEAN NOT NULL DEFAULT false;

-- Index UNIQUE PARTIEL : garantit 1 seul Account par user avec
-- is_default_for_mail = true. Sans WHERE on aurait UNIQUE(userId) ce qui
-- casserait : un user a 1+ Accounts. Avec WHERE on cible que les "true".
-- @safe: index sur colonne fraîchement créée à false partout → vide → instantané
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_user_default_for_mail_unique"
    ON "hub_app"."accounts" ("user_id")
    WHERE "is_default_for_mail" = true;

-- ─── Table 1 : mail_recipient_rate_limit ───────────────────────────────────
-- 1 row par recipient_email — UPSERT à chaque envoi réussi. Le check de
-- rate-limit lit cette row pour déterminer le retry_after.
-- @safe: CREATE TABLE pure
CREATE TABLE IF NOT EXISTS "hub_app"."mail_recipient_rate_limit" (
    "recipient_email"   TEXT           NOT NULL,
    "last_sent_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sender_user_id"    TEXT           NOT NULL,
    "app_caller"        TEXT           NOT NULL,

    CONSTRAINT "mail_recipient_rate_limit_pkey" PRIMARY KEY ("recipient_email")
);

-- Index timeline pour purge cron (P3+) : "supprime les rows dont
-- last_sent_at est trop vieille pour matter".
-- @safe: index sur table créée dans la même migration (vide)
CREATE INDEX IF NOT EXISTS "mail_recipient_rate_limit_last_sent_at_idx"
    ON "hub_app"."mail_recipient_rate_limit" ("last_sent_at" DESC);

-- ─── Table 2 : mail_rate_limit_events ──────────────────────────────────────
-- Append-only audit forensics. 1 row par destinataire bloqué (207 ou 429).
-- @safe: CREATE TABLE pure
CREATE TABLE IF NOT EXISTS "hub_app"."mail_rate_limit_events" (
    "id"                    TEXT           NOT NULL,
    "timestamp"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient_email"       TEXT           NOT NULL,
    "sender_user_id"        TEXT           NOT NULL,
    "app_caller"            TEXT           NOT NULL,
    "retry_after_seconds"   INTEGER        NOT NULL,

    CONSTRAINT "mail_rate_limit_events_pkey" PRIMARY KEY ("id")
);

-- Index principal : timeline globale DESC pour le dashboard admin.
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "mail_rate_limit_events_timestamp_idx"
    ON "hub_app"."mail_rate_limit_events" ("timestamp" DESC);

-- Index secondaire : top destinataires bloqués (group by recipient_email).
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "mail_rate_limit_events_recipient_idx"
    ON "hub_app"."mail_rate_limit_events" ("recipient_email", "timestamp" DESC);

-- Index secondaire : top senders bloqués.
-- @safe: index sur table vide
CREATE INDEX IF NOT EXISTS "mail_rate_limit_events_sender_idx"
    ON "hub_app"."mail_rate_limit_events" ("sender_user_id", "timestamp" DESC);
