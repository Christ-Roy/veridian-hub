# [HUB] Implémenter GET /api/tenants/{id}/billing-state (réconciliation POLL)

> **Sévérité** : 🟡 P2 — non bloquant (retry Stripe + idempotence couvrent
>   99,9 % des cas), mais c'est le filet de la réconciliation §6.3 du contrat
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Réfère** : `docs/CONTRAT-BILLING.md` v2.0 §6.3 (réconciliation POLL)

## Contexte

`docs/CONTRAT-BILLING.md` v2.0 a été extrait et gravé (commit `8ebad20`).
La §6.3 grave la stratégie de réconciliation = **POLL** (décision Robert) :
en cas de Hub down > 3 jours (au-delà du retry Stripe), une app downstream
doit pouvoir se resync en pollant le Hub.

L'endpoint est **spec'd dans le contrat mais n'existe pas encore** côté code.

## À livrer

`GET /api/tenants/{tenant_id}/billing-state` :
- Auth : HMAC app → Hub (Pattern A, cf `CONTRAT-HUB.md` §6.1 — réutiliser
  le pattern existant, voir `lib/` côté vérification HMAC inbound).
- Réponse : `{ plan, plan_source, stripe_subscription_id, effective_at,
  updated_at }` — exactement le shape gravé §6.3 du contrat.
- `plan_source` ∈ enum fermé `stripe | stripe_trial | grant_manual |
  downgrade_auto` (cf §3.3 CONTRAT-BILLING).
- Idempotent, lecture seule, pas de hot path (les apps pollent ~1×/jour).
- 404 si tenant inconnu, 401 si HMAC invalide.

## DoD

- [ ] Route `app/api/tenants/[tenantId]/billing-state/route.ts` créée
- [ ] HMAC inbound vérifié (constant-time, anti-replay)
- [ ] Réponse conforme au shape §6.3 CONTRAT-BILLING.md v2.0
- [ ] Tests : HMAC OK/KO, tenant connu/inconnu, shape de réponse
- [ ] Section §6.3 du contrat annotée "endpoint livré"
