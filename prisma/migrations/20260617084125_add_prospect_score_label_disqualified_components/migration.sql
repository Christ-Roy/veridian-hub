-- Migration : score prospect explicable + recompute pur.
-- Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
-- (chantier remplacement du bridge tunnel-de-vente par le réconciliateur Hub).
--
-- Ajoute 3 colonnes à `hub_app.prospect_scores` pour porter le barème RICHE du
-- bridge (caps, non-cumul, récence, disqualif) en mode RECOMPUTE PUR :
--
--   * `label`        : froid / tiede / chaud (dérivé du score, seuil chaud 30).
--   * `disqualified` : bounce dur OU unsubscribe → score 0 + doNotContact CRM.
--   * `components`   : détail des points par composant (JSONB) — le score n'est
--     pas une boîte noire, poussé tel quel dans le CRM Twenty.
--
-- Expand & Contract : ADD COLUMN avec DEFAULT non-volatile (constante) = pas de
-- réécriture de table (Postgres 11+ : DEFAULT constant stocké en métadonnée, pas
-- de rewrite). Additive, idempotente, zéro impact sur les rows existantes (au
-- 2026-06-17 la table est VIDE en prod — aucun émetteur ne l'alimente encore,
-- cf CONTRAT-HUB §7.5). Le tag Docker précédent tourne dessus sans connaître ces
-- colonnes (les NOT NULL ont un DEFAULT → INSERT legacy reste valide).

-- @safe: ADD COLUMN avec DEFAULT constant (pas de table rewrite), table vide en prod
ALTER TABLE "hub_app"."prospect_scores"
    ADD COLUMN IF NOT EXISTS "label" TEXT NOT NULL DEFAULT 'froid';

-- @safe: ADD COLUMN avec DEFAULT constant
ALTER TABLE "hub_app"."prospect_scores"
    ADD COLUMN IF NOT EXISTS "disqualified" BOOLEAN NOT NULL DEFAULT false;

-- @safe: ADD COLUMN avec DEFAULT constant
ALTER TABLE "hub_app"."prospect_scores"
    ADD COLUMN IF NOT EXISTS "components" JSONB NOT NULL DEFAULT '{}';
