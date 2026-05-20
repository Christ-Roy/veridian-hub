-- Table `hub_app.cross_app_invitations` pour invitations cross-app.
--
-- Voir prisma/schema.prisma → model CrossAppInvitation pour le rôle métier :
-- une app downstream (Notifuse, Prospection, ...) demande au Hub d'inviter
-- un user (via email) à rejoindre un de ses workspaces. Le Hub gère le token,
-- l'envoi du magic link, et l'identification du user à l'acceptation.
--
-- Distinct de `hub_app.invitations` qui couvre les invitations workspace
-- internes Hub (multi-membre Hub billing). Ici l'invitation pointe vers
-- une ressource EXTERNE au Hub : `target_workspace_id` est un id opaque
-- côté DB downstream, pas une FK Prisma.
--
-- Existing tenants: nouvelle table, zéro impact sur les rows existantes.
-- Aucune backfill nécessaire. Zéro downtime.

-- @safe: CREATE TABLE pure, pas de modification d'objet existant
CREATE TABLE IF NOT EXISTS "hub_app"."cross_app_invitations" (
    "id"                    TEXT        NOT NULL,
    "token"                 TEXT        NOT NULL,
    "inviter_user_id"       TEXT        NOT NULL,
    "inviter_email"         TEXT        NOT NULL,
    "invitee_email"         TEXT        NOT NULL,
    "target_app"            TEXT        NOT NULL,
    "target_workspace_id"   TEXT        NOT NULL,
    "target_role"           TEXT        NOT NULL DEFAULT 'member',
    "message"               TEXT,
    "expires_at"            TIMESTAMP(3) NOT NULL,
    "accepted_at"           TIMESTAMP(3),
    "accepted_by_user_id"   TEXT,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cross_app_invitations_pkey" PRIMARY KEY ("id")
);

-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "cross_app_invitations_token_key"
    ON "hub_app"."cross_app_invitations" ("token");

-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "cross_app_invitations_invitee_email_idx"
    ON "hub_app"."cross_app_invitations" ("invitee_email");

-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "cross_app_invitations_target_app_workspace_idx"
    ON "hub_app"."cross_app_invitations" ("target_app", "target_workspace_id");

-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "cross_app_invitations_expires_at_idx"
    ON "hub_app"."cross_app_invitations" ("expires_at");

-- FK inviter → users : empêche de créer une invitation au nom d'un user inexistant.
-- Pas de ON DELETE CASCADE pour conserver l'historique d'audit si un user est purgé.
ALTER TABLE "hub_app"."cross_app_invitations"
    ADD CONSTRAINT "cross_app_invitations_inviter_user_id_fkey"
    FOREIGN KEY ("inviter_user_id")
    REFERENCES "hub_app"."users"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- FK accepted_by → users : qui a accepté (peut différer de invitee_email si
-- l'user a accepté avec un compte ayant un email différent — cas warning UI).
ALTER TABLE "hub_app"."cross_app_invitations"
    ADD CONSTRAINT "cross_app_invitations_accepted_by_user_id_fkey"
    FOREIGN KEY ("accepted_by_user_id")
    REFERENCES "hub_app"."users"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE;
