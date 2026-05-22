# Synchroniser le HMAC secret Hub ↔ Analytics

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-22
> **Demandé par** : agent veridian-analytics-engine (giga-sprint 2026-05-22)

## Contexte

Le sprint giga 2026-05-22 a livré côté `veridian-analytics-engine` les 3 endpoints HMAC du contrat Hub (ticket B3 : `POST /api/tenants/provision`, `POST /api/tenants/attach-owner`, `GET /api/tenants/:id/health`). Ces endpoints vérifient une signature `X-Hub-Signature` = HMAC-SHA256(secret, `${ts}.${body}`).

Pour que le Hub puisse appeler Analytics, **les deux apps doivent partager le même secret HMAC**.

## Demande

Le secret staging a été généré et stocké :
- **Nom** : `HUB_HMAC_SECRET_ANALYTICS_STAGING`
- **Valeur** : dans `~/credentials/.all-creds.env` (clé `HUB_HMAC_SECRET_ANALYTICS_STAGING`)
- Déjà posé comme secret GitHub Actions sur `veridian-analytics-engine`

**Action côté Hub** (quand le client Analytics sera câblé dans le Hub) :
1. Récupérer la valeur dans `~/credentials/.all-creds.env`
2. La poser en secret GitHub `veridian-hub` (nom à choisir selon convention Hub, ex : `ANALYTICS_HUB_API_SECRET_STAGING`)
3. L'injecter dans l'ENV du client Analytics côté Hub (`veridian-hub/lib/analytics/` quand il existera)
4. Pour la prod : générer un `HUB_HMAC_SECRET_ANALYTICS_PROD` distinct le moment venu

## Priorité

P2 — pas urgent. Analytics n'est pas encore en SaaS public, le Hub n'appelle pas encore Analytics. À faire quand l'intégration Hub→Analytics sera activée (cf. `veridian-analytics/todo/2026-05-20-hub-integration-when-saas-launched.md`).

Tant que ce n'est pas fait, le bridge Analytics tourne en mode `SKIP_HMAC=true` en dev (cf CONTRAT-HUB §6.6).
