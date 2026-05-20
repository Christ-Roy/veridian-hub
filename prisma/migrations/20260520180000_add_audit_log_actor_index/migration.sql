-- Index actor pour requêtes forensics "qui a fait quoi sur quelle période".
--
-- Sans cet index : SELECT * FROM audit_log WHERE actor = 'admin:robert@x'
-- → full scan. Avec : btree lookup direct.
--
-- L'ordre (actor, created_at DESC) permet aussi les queries paginées du
-- type "dernières actions de l'admin X".
--
-- Existing tenants: table audit_log a peu de rows (< 100 au 2026-05-20),
-- index instantané, zéro downtime.

-- @safe: index sur table petite (<100 rows) — lock instantané
CREATE INDEX IF NOT EXISTS "audit_log_actor_created_at_idx" ON "hub_app"."audit_log" ("actor", "created_at" DESC);
