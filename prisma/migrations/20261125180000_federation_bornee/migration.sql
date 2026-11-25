-- La session née d'un fournisseur sait de quelle organisation : elle n'ouvre qu'elle. Colonne facultative, tickets de 60 s : un ticket d'avant est refusé.
ALTER TABLE "hub_app"."federation_tickets" ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
