# Marquer Analytics ✅ dans CONTRAT-HUB §10

> **Sévérité** : 🟢 P2 (documentation)
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-22
> **Auteur** : agent veridian-analytics-engine (B3)

## Contexte

Le ticket B3 du giga-sprint 2026-05-22 a livré côté `veridian-analytics-engine`
(branche `feat/B3-hub-contract-base` → mergée sur `dev`) :

1. `veridian-bridge/src/hub-hmac.ts` — lib HMAC Hub (Pattern A §6.1) :
   - `verifyHubHmac()` : HMAC-SHA256(secret, `${ts}.${body}`)
   - Anti-replay 5min
   - Constant-time compare
   - Mode dev `SKIP_HMAC=true` (refuse en prod/staging)
2. `veridian-bridge/src/paywall.ts` — `requireActivePlan()` V1 stub (V2 = ticket S3)
3. **3 endpoints HMAC** sous `/api/tenants/*` :
   - `POST /api/tenants/provision` (§5.1 — 3 cas idempotents A/B/C)
   - `POST /api/tenants/attach-owner` (§5.3 — idempotent)
   - `GET /api/tenants/:id/health` (§5.5)
4. **11 fichiers de tests** (42 tests verts) dans `veridian-bridge/tests/hub/`
5. `.env.example` documenté avec `HUB_HMAC_SECRET` + `SKIP_HMAC`

## Demande

Dans `veridian-hub/docs/CONTRAT-HUB.md`, mettre à jour la **matrice §10** :

### §10.1 Endpoints downstream (ligne 2692+)

Passer la colonne **Analytics** de `❌` à `✅` sur 3 lignes :

| Endpoint | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| 1. `POST provision` (§5.1) | ✅ | ✅ | **✅ B3 2026-05-22** | ❌ |
| 3. `POST attach-owner` (§5.3) | ✅ | ✅ | **✅ B3 2026-05-22** | ❌ |
| 6. `GET health` (§5.5) | ✅ | ✅ | **✅ B3 2026-05-22** | ❌ |

Mettre à jour le score : Analytics passe de `0/22` à `3/22 = 14 %`.

### §10.4 Auth & sécurité (ligne 2748+)

Passer Analytics de `—` à `✅` :

| Item | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| HMAC standard `{ts}.{body}` | ✅ | ✅ | **✅** | — |
| Anti-replay timestamp 5min | ✅ | ✅ | **✅** | — |
| Comparaison temps constant | ✅ | ✅ | **✅** (`crypto.timingSafeEqual`) | — |
| Pas de password user en DB | ✅ | ✅ | **✅** (jamais stocké côté bridge) | — |
| Magic link only auth | ✅ | ✅ | **—** (pas encore d'auth user côté bridge, voir S3) | — |
| Legacy HMAC accepté (transition) | — | ✅ | **—** | — |
| SKIP_HMAC bloqué en prod/staging | ✅ | ✅ | **✅** (`assertSkipHmacAllowed()`) | — |

## Tickets restants Analytics (pour info)

- 🔴 **§5.2 update-plan** : reporté
- 🔴 **§5.4 suspend/resume** : ticket S3 prévu
- 🔴 **§5.6 generateMagicLink** : Pattern B Bearer api_key — pas dans B3
- 🟡 **§5.8 lifecycle complet** (soft-delete/restore/purge) : ticket S3
- 🟡 **§5.18 multi-membre cross-app** : roadmap v1.4

## ENV à coordonner

Le secret HMAC partagé Hub ↔ Analytics doit exister des deux côtés.
Convention §6.5 :
- Côté Hub : `ANALYTICS_HUB_API_SECRET` (prod) / `ANALYTICS_HUB_API_SECRET_STAGING`
- Côté bridge Analytics : `HUB_HMAC_SECRET` (même var pour les 2 env, c'est le .env qui change)

Si le secret n'existe pas encore dans `~/credentials/.all-creds.env`, en
générer un (32+ chars hex) et le partager dans les 2 environnements.

## Sortie attendue

Un commit sur la branche `staging` Hub :

```
docs(contrat): mark Analytics ✅ pour provision + attach-owner + health (B3)

Ticket B3 du giga-sprint 2026-05-22 livré côté veridian-analytics-engine
(branche feat/B3-hub-contract-base → dev). 42 tests verts.
```
