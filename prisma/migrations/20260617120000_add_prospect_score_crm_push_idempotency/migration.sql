-- Migration : idempotence SORTANTE du push CRM (cron push-prospect-scores).
-- Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
-- (chantier remplacement du bridge tunnel-de-vente par le réconciliateur Hub).
--
-- Le cron `push-prospect-scores` (couche scoring DÉCOUPLÉE, archi Robert
-- 2026-06-17) recalcule le score d'un prospect FROM-SCRATCH puis le pousse au
-- CRM Twenty. Pour NE PAS spammer le CRM à chaque tick horaire, il faut savoir
-- si le score a CHANGÉ depuis le dernier push réussi. Ces deux colonnes portent
-- l'état du DERNIER push :
--
--   * `crm_pushed_score` : valeur d'`engagement_score` au moment du push réussi.
--     Le cron compare `crm_pushed_score IS DISTINCT FROM engagement_score` avant
--     de pousser. NULL = jamais poussé (premier push inconditionnel si scorable).
--   * `crm_pushed_at`    : horodatage du dernier push réussi (observabilité).
--
-- En DRY_RUN le cron NE met PAS à jour ces colonnes (rien n'a été réellement
-- envoyé au CRM) — l'idempotence sortante ne « consomme » que les vrais pushes.
--
-- Expand & Contract : ADD COLUMN NULLABLE (pas de DEFAULT volatile) = pas de
-- réécriture de table (Postgres 11+). Additive, idempotente, zéro impact sur les
-- rows existantes (au 2026-06-17 la table est VIDE en prod — aucun émetteur ne
-- l'alimente encore, cf CONTRAT-HUB §7.5). Le tag Docker précédent tourne dessus
-- sans connaître ces colonnes (nullable → INSERT legacy reste valide).

-- @safe: ADD COLUMN nullable (pas de table rewrite), table vide en prod
ALTER TABLE "hub_app"."prospect_scores"
    ADD COLUMN IF NOT EXISTS "crm_pushed_at" TIMESTAMPTZ(6);

-- @safe: ADD COLUMN nullable (pas de table rewrite)
ALTER TABLE "hub_app"."prospect_scores"
    ADD COLUMN IF NOT EXISTS "crm_pushed_score" INTEGER;
