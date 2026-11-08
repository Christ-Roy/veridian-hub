-- Ancienne intégration du CRM (mai 2026) : mot de passe et Bearer Twenty chiffrés par tenant, contraires à
-- CONTRAT-HUB §3.8 (le Hub seul gère l'identité, l'app ne garde aucun mot de passe). Remplacée par le
-- provisioning signé et le rebond `issue-magic-link`. Mesuré le 08/11/2026 : 0 ligne en prod, 5 essais
-- du 27/05 en staging.
DROP TABLE IF EXISTS "hub_app"."crm_tenants";
