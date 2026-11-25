-- Aucun plan par défaut (22/11) : un espace neuf n'a pas de plan tant que personne n'en pose un. Les lignes existantes ne changent pas.
ALTER TABLE "hub_app"."tenants" ALTER COLUMN "prospection_plan" DROP DEFAULT;
