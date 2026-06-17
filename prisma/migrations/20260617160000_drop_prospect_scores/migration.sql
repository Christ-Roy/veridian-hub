-- Drop de la table prospect_scores (scoring centralisé retiré du Hub).
-- Décision Robert 2026-06-17 : le Hub est un bus d'events pur, le scoring vit
-- dans le CRM Twenty de chaque tenant (réglable par workspace). La table était
-- VIDE en prod (0 row, scoring jamais activé en réel) → drop sans perte.
-- @safe: table prospect_scores VIDE en prod (0 row vérifié 2026-06-17, scoring jamais activé en réel), lue par aucun code après suppression du cron+route admin, scoring déplacé vers le CRM tenant — validé Robert
DROP TABLE IF EXISTS "hub_app"."prospect_scores";
