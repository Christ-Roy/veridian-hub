-- Migration : Mail Gateway v1 Gmail-only (ticket
-- 2026-05-25-gmail-send-implementation-hub.md).
--
-- 1. Crée la table `hub_app.mail_events` : audit cross-app des envois de
--    mail au nom de l'user via le broker Hub (Gmail v1, Microsoft v2).
--    Append-only. Permet idempotence (unique idempotency_key) + dashboard
--    volumétrie par (user, app).
--
-- 2. Ajoute 2 colonnes à `hub_app.accounts` :
--    - `mail_send_needs_reauth BOOLEAN DEFAULT false` : flag levé par le
--      broker quand un refresh_token retourne invalid_grant (révocation
--      côté provider). L'UI settings/mail affiche un warning rouge + bouton
--      reconnecter dès que la valeur passe à true.
--    - `mail_send_scope TEXT` : liste blanche des scopes obtenus par cet
--      Account (CSV : "openid email profile https://www.googleapis.com/auth/gmail.send").
--      Permet de distinguer un Account sign-in basic d'un Account autorisé
--      à envoyer du mail — le broker ne sélectionne que les Accounts dont
--      le scope contient gmail.send.
--
-- Existing tenants: aucun impact runtime.
--   * `mail_events` est une table neuve, vide — pas d'ALTER, pas de backfill.
--   * Les 2 nouvelles colonnes `accounts` ont des défauts safes (false / NULL).
--     Les Accounts OAuth Google sign-in existants ne sont JAMAIS éligibles à
--     l'envoi de mail tant que `mail_send_scope` ne contient pas `gmail.send`.
--     Pour ces Accounts pré-existants la valeur reste NULL → ils ne peuvent
--     pas envoyer = comportement par défaut sécurisé.
--   * Zero downtime : aucun lock long, juste ADD COLUMN avec défauts.

-- @safe: CREATE TABLE pure, pas de modification d'objet existant
CREATE TABLE IF NOT EXISTS "hub_app"."mail_events" (
    "id"                  TEXT           NOT NULL,
    "user_id"             TEXT           NOT NULL,
    "app_source"          TEXT           NOT NULL,
    "provider"            TEXT           NOT NULL,
    "recipient"           TEXT           NOT NULL,
    "subject"             TEXT           NOT NULL,
    "provider_message_id" TEXT,
    "status"              TEXT           NOT NULL,
    "error_message"       TEXT,
    "idempotency_key"     TEXT           NOT NULL,
    "sent_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_events_pkey" PRIMARY KEY ("id")
);

-- Unicité de idempotency_key : 2e POST avec la même clé renvoie le résultat
-- du 1er (idempotent replay) sans relancer un envoi Gmail.
-- @safe: index unique sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "mail_events_idempotency_key_key"
    ON "hub_app"."mail_events" ("idempotency_key");

-- Index principal : timeline par user, ordre DESC (audit "qu'est-ce que ce
-- user a envoyé récemment ?").
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "mail_events_user_id_sent_at_idx"
    ON "hub_app"."mail_events" ("user_id", "sent_at" DESC);

-- Index secondaire : timeline par app source (dashboard cross-app).
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "mail_events_app_source_sent_at_idx"
    ON "hub_app"."mail_events" ("app_source", "sent_at" DESC);

-- FK vers users avec cascade (cohérent avec Account.user) : si on supprime
-- un user, ses mail_events partent aussi (RGPD : pas de PII orphelin).
-- @safe: FK sur table créée dans la même migration (vide) — lock instantané
ALTER TABLE "hub_app"."mail_events"
    ADD CONSTRAINT "mail_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "hub_app"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- @safe: ADD COLUMN avec défaut booléen — pas de rewrite de table sur PG ≥ 11
ALTER TABLE "hub_app"."accounts"
    ADD COLUMN IF NOT EXISTS "mail_send_needs_reauth" BOOLEAN NOT NULL DEFAULT false;

-- @safe: ADD COLUMN nullable sans défaut — instantané, aucun rewrite
ALTER TABLE "hub_app"."accounts"
    ADD COLUMN IF NOT EXISTS "mail_send_scope" TEXT;
