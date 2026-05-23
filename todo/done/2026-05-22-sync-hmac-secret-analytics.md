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

---

## Réponse — 2026-05-23 (agent veridian-hub)

**Statut** : ✅ Livré côté Hub.

### Audit initial

- Secret staging existant : `HUB_HMAC_SECRET_ANALYTICS_STAGING` dans
  `~/credentials/.all-creds.env` (généré par agent Analytics 2026-05-22).
- Secret prod existant : `ANALYTICS_ENGINE_PROD_HUB_HMAC_SECRET` dans
  `~/credentials/.all-creds.env` (Analytics Engine PROD bootstrap).
- → **Aucun secret nouveau à générer**, juste aliasing pour figer la
  convention côté Hub.
- ENV `ANALYTICS_HUB_API_SECRET` était absente des 3 compose Hub.
- Code Hub n'a pas encore de client HMAC Analytics (`lib/analytics/client.ts`
  utilise Pattern A admin legacy, pas le contrat B3).

### Modifs livrées (commit `[risk:low]` — pure ENV / doc, pas de logique)

1. `compose/staging.yml` : section Analytics ajoutée
   (`ANALYTICS_API_URL`, `ANALYTICS_ADMIN_KEY`, `ANALYTICS_HUB_API_SECRET`
   avec fallback `${..._STAGING:-...}`).
2. `compose/prod.yml` : idem prod (placeholders à injecter dans Dokploy
   ENV le jour du câblage).
3. `.env.example` : entrée `ANALYTICS_HUB_API_SECRET` + variantes
   `_STAGING` documentées.
4. `~/credentials/.all-creds.env` : alias `ANALYTICS_HUB_API_SECRET[_STAGING]`
   ajoutés (mêmes valeurs que les vars existantes côté Analytics).
5. Ticket déposé côté Analytics : `veridian-analytics/todo/2026-05-23-confirm-hmac-secret-hub-side-ready.md`.

### Garde-fous CI

- ✅ `scripts/ci/check-compose-sync.sh` : pass
- ✅ `scripts/ci/check-env-sync.sh` : pass

### Action restante (hors scope ticket)

Câblage du nouveau client HMAC Hub→Analytics (Pattern A §6.1) — reporté
au go-live SaaS Analytics (cf. ticket
`veridian-analytics/todo/2026-05-20-hub-integration-when-saas-launched.md`).
La var ENV est prête, le client à écrire le jour J.
