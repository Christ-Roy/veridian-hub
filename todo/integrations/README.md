# Intégration Hub — contrat pour les apps downstream

> **Audience** : agents et devs travaillant sur Notifuse, Prospection, Analytics, CMS, ou toute future app branchée sur le Hub Veridian.
>
> **Auteur** : agent Hub (`veridian-hub`).
>
> **Statut** : v1 — 2026-05-17. Toute évolution majeure passe par commit direct sur staging avec brief explicite.

## Pourquoi ce dossier existe

Le Hub Veridian est l'**orchestrateur** du SaaS. Il owne :
- L'authentification utilisateur (Auth.js v5)
- Le billing Stripe (1 customer, N subscriptions par app)
- Le provisioning à la demande des tenants côté apps downstream
- Le routage auto-login (SSO Hub → app)

Les apps downstream (Notifuse, Prospection, Analytics, CMS) **n'ont pas** d'inscription publique : elles reçoivent leurs tenants **via le Hub uniquement**. Pour que ça fonctionne, chaque app doit implémenter un **contrat HTTP standard** documenté ici.

## Le modèle en 1 schéma

```
                    ┌───────────────────────────┐
                    │   USER (browser)          │
                    └────┬──────────────────┬───┘
                         │ 1. signup        │ 5. open auto-login URL
                         │ + login          │    (after click "Activate X")
                         ▼                  ▼
                    ┌─────────────────────────────┐
                    │   HUB (app.veridian.site)   │
                    │                             │
                    │  - Auth.js session          │
                    │  - Stripe billing           │
                    │  - DB hub_app.tenants       │
                    │  - DB hub_app.users         │
                    └────┬────────────────────┬───┘
                         │ 2. provision       │ 4. generate magic link
                         │    (HMAC)          │    (Bearer api_key)
                         │ 3. webhook events  │
                         ▼  (Bearer hub_token)│
                    ┌─────────────────────────────┐
                    │   APP DOWNSTREAM            │
                    │   (Notifuse / Prospection)  │
                    │                             │
                    │  - DB tenants/workspaces    │
                    │  - DB user_workspaces       │
                    │  - JWT session              │
                    └─────────────────────────────┘
```

## Les 5 endpoints obligatoires (côté app downstream)

Chaque app doit exposer, sous le préfixe `/api/tenants/*` (ou équivalent versionné) :

| # | Endpoint | Auth | Trigger | Détails |
|---|---|---|---|---|
| 1 | `POST /api/tenants/provision` | HMAC Hub | User active l'app via Hub dashboard | Crée tenant + user owner + attach owner |
| 2 | `POST /api/tenants/attach-owner` | HMAC Hub | Hub répare un tenant cassé OU change owner | Idempotent. Crée user si nécessaire, attache au workspace en `owner`/`admin` |
| 3 | `POST /api/tenants/suspend` | HMAC Hub | Stripe webhook → subscription canceled/past_due | Bloque l'accès sans détruire la data |
| 4 | `POST /api/tenants/resume` | HMAC Hub | Stripe webhook → subscription resumed | Réactive l'accès |
| 5 | `GET /api/tenants/{id}/health` | HMAC Hub | Cron Hub 1×/h ou check manuel | Renvoie l'état réel observable du tenant |

**Endpoints optionnels** mais fortement recommandés :

| 6 | `POST /api/workspaces.generateMagicLink` | Bearer API key tenant | User click "Open <App>" depuis Hub | Renvoie auto-login URL self-contained |
| 7 | `DELETE /api/tenants/{id}` | HMAC Hub | Hard delete admin uniquement | Soft delete possible si data précieuse |

## Authentification : 3 patterns

### Pattern A — HMAC Hub (machine-to-machine)

Pour tout endpoint que le Hub appelle en sa propre identité (provision, suspend, resume, attach-owner, health).

**Headers** :
```
X-Veridian-Timestamp: <unix_ms>
X-Veridian-Hub-Signature: <hex(hmac_sha256(secret, "{timestamp}.{raw_body}"))>
Content-Type: application/json
```

**Vérification côté app** :
1. Reject si `|now - timestamp| > 5min` (anti-replay)
2. Recompute signature avec `HUB_API_SECRET` partagé
3. Compare en temps constant

Le secret est échangé hors-bande au provisioning de l'app (via `~/credentials/.all-creds.env`).

### Pattern B — Bearer API key tenant (user-to-app via Hub)

Pour `/api/workspaces.generateMagicLink`. Le Hub a stocké l'API key reçue au provisioning et la présente côté tenant.

**Headers** :
```
Authorization: Bearer <tenant_api_key>
Content-Type: application/json
```

L'API key doit être **scoped à un seul workspace** (l'app doit refuser un `generateMagicLink` si l'API key est attachée à plusieurs workspaces — voir Notifuse `veridian_magic_handler.go` pour le pattern de référence).

### Pattern C — Bearer Hub token (webhook app→Hub)

Pour les webhooks **app → Hub** (état changé côté app, doit être propagé). Le Hub expose `POST /api/webhooks/<app>` qui valide un token statique.

**Headers (app → Hub)** :
```
Authorization: Bearer <HUB_WEBHOOK_TOKEN_<APP>>
Content-Type: application/json
```

Token unique par app, stocké côté Hub en ENV et côté app dans `.env`.

## Contrats par endpoint

### 1. `POST /api/tenants/provision`

**Request** :
```json
{
  "tenant_id": "string (slug stable, unique côté Hub)",
  "owner_email": "string (email du user humain owner)",
  "workspace_name": "string (display name)",
  "plan": "free|starter|pro|enterprise",
  "metadata": {
    "hub_user_id": "string (Hub Tenant.userId, pour traçabilité)",
    "stripe_customer_id": "string (optionnel)"
  }
}
```

**Response 200** :
```json
{
  "tenant_id": "string (echo)",
  "workspace_id": "string (id app-side, peut différer du tenant_id)",
  "owner_user_id": "string (id du user owner créé/attaché côté app)",
  "owner_email": "string (echo)",
  "api_key": "string (à stocker côté Hub pour générer les magic links plus tard)",
  "api_key_email": "string (email technique du compte API key)",
  "plan": "string (echo)",
  "created": true,
  "magic_link": "string (URL signin one-shot, TTL ~15min, optionnel mais recommandé)",
  "auto_login_url": "string (URL self-contained TTL court, optionnel)"
}
```

**Invariants côté app** :
- Le `owner_email` est créé comme `user` (pas `api_key`) si pas déjà présent.
- Le user owner est attaché au workspace avec `role = "owner"`.
- L'API key retournée est attachée au workspace avec `role = "member"`.
- Si appelé 2× avec le même `tenant_id` + `owner_email`, retourne `created: false` mais reste fonctionnel (idempotence).

### 2. `POST /api/tenants/attach-owner`

> 🔥 **Nouvel endpoint exigé suite au bug Notifuse 2026-05-17** (cf `notifuse-fix-2026-05-17.md`).

**Request** :
```json
{
  "tenant_id": "string",
  "owner_email": "string",
  "role": "owner|admin (default: owner)"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "owner_email": "string",
  "user_id": "string (créé ou existant)",
  "attached": true,
  "already_attached": false,
  "role": "owner"
}
```

**Response 404** : tenant inexistant côté app.
**Response 422** : `owner_email` invalide.

**Comportement** :
- Si user n'existe pas → créer (`type: user`, sans password, sans email vérifié).
- Si user existe et déjà attaché avec le bon role → `already_attached: true`.
- Si user existe et attaché avec un role différent → upgrade au role demandé.
- **Additif uniquement** : on ne retire jamais un owner existant.

### 3. `POST /api/tenants/suspend`

**Request** : `{"tenant_id": "string", "reason": "billing_past_due|admin_action|quota_exceeded"}`

**Response 200** : `{"tenant_id": "string", "suspended_at": "ISO8601"}`

**Comportement** : marquer le tenant comme suspendu, bloquer tout accès écriture côté app, ne pas supprimer la data.

### 4. `POST /api/tenants/resume`

**Request** : `{"tenant_id": "string"}`

**Response 200** : `{"tenant_id": "string", "resumed_at": "ISO8601"}`

Annule l'effet de `suspend`. Idempotent.

### 5. `GET /api/tenants/{id}/health`

Le bug Notifuse 2026-05-17 était entièrement détectable via un endpoint health. **Obligatoire désormais.**

**Response 200** :
```json
{
  "tenant_id": "string",
  "workspace_id": "string",
  "status": "active|suspended|deleted",
  "owner_attached": true,
  "owner_email": "string (l'email actuellement owner côté app)",
  "owner_user_id": "string",
  "api_key_valid": true,
  "magic_link_capable": true,
  "members_count": 1,
  "checked_at": "ISO8601"
}
```

**`magic_link_capable: false`** doit être renvoyé si :
- Pas d'owner humain attaché (cas du bug Notifuse).
- API key révoquée.
- Tenant soft-deleted.

Le Hub appelle cet endpoint en cron 1×/h pour les tenants actifs et stocke le résultat dans `hub_app.tenant_health_check` (à créer côté Hub).

### 6. `POST /api/workspaces.generateMagicLink`

Voir spec actuelle Notifuse (`veridian_magic_handler.go`). À reprendre tel quel par les autres apps.

**Request** : `{"user_email": "string"}`

**Response 200** :
```json
{
  "magic_link": "string (URL signin one-shot, TTL ~15min)",
  "auto_login_url": "string (URL self-contained, TTL ~60s)",
  "expires_at": "ISO8601"
}
```

**Response 404** : user pas membre du workspace.
**Response 409** : api_key attachée à plusieurs workspaces (ambigu).

## Webhooks app → Hub (NEW)

Endpoint Hub : `POST https://app.veridian.site/api/webhooks/<app_name>` (`notifuse`, `prospection`, `analytics`, `cms`).

Auth via Bearer token statique : `Authorization: Bearer <HUB_WEBHOOK_TOKEN_<APP>>`.

### Événements obligatoires

| Event | Quand | Payload |
|---|---|---|
| `tenant.suspended` | App suspend localement (quota, admin) | `{event, tenant_id, suspended_at, reason}` |
| `tenant.resumed` | App resume | `{event, tenant_id, resumed_at}` |
| `tenant.deleted` | App hard-delete | `{event, tenant_id, deleted_at}` |
| `tenant.owner_changed` | App change l'owner (admin action) | `{event, tenant_id, old_owner_email, new_owner_email}` |
| `tenant.quota_exceeded` | Soft alert (pas blocking) | `{event, tenant_id, quota_type, current, limit}` |

### Format webhook standard

```json
{
  "event": "tenant.suspended",
  "tenant_id": "string",
  "occurred_at": "ISO8601",
  "data": { ... },
  "idempotency_key": "string (uuid v4, le Hub déduplique sur 24h)"
}
```

Le Hub répond `200 OK` si reçu, `409` si déjà traité (idempotence), `400` si payload invalide. **Retry recommandé en cas de 5xx** (backoff exponentiel, max 1h).

## Provisioning à la demande (modèle cible)

> 🔥 **Décision architecture 2026-05-17** : on quitte le pattern "tout provisionner au signup" pour aller vers "activation à la demande, freemium par app".

### Flow user

1. **Signup Hub** = créer compte + workspace Hub + Stripe customer. **AUCUN tenant downstream créé.**
2. Dashboard Hub affiche les apps disponibles avec bouton "Activate" (`Notifuse`, `Prospection`, `Analytics`...).
3. User click "Activate Notifuse" :
   - Hub crée `hub_app.tenants` row avec `status: provisioning`, `app: notifuse`.
   - Hub appelle `POST notifuse/api/tenants/provision`.
   - Réponse 200 → Hub stocke `api_key`, passe à `status: active`, affiche checkmark.
   - Réponse erreur → Hub passe à `status: failed`, affiche retry bouton.
4. User click "Open Notifuse" → Hub appelle `generateMagicLink`, ouvre l'URL.

### Conséquence côté apps downstream

- **Provision = synchrone obligatoirement.** Plus de mode "fire and forget".
- **Idempotent** : si user click 2× sur Activate, deuxième call retourne `created: false` proprement.
- **Plan freemium par défaut** : `plan: "freemium"` au premier appel. Upgrade via `update-plan` plus tard quand Stripe webhook arrive.
- **Pas de provisioning shadow** : si l'user n'a pas explicitement activé, l'app n'a aucune trace de lui.

## Versionnement et compatibilité

- **API breaking change** : ajouter `/api/v2/tenants/*` en parallèle. Le Hub bascule progressivement. Pas de hot-swap silencieux.
- **Schema response** : ajout de champs OK, suppression NON. Le Hub fait des `optional chaining` partout côté client.
- **Codes d'erreur** : ajouter dans la liste publique de ce README, jamais réutiliser un code pour un sens différent.

## Tests d'intégration exigés (côté chaque app)

Chaque app downstream **doit** maintenir, dans son repo, un test d'intégration qui vérifie le contrat Hub. Le scénario minimal :

```
1. provision(tenant_id=T1, owner_email=alice@test, plan=freemium)
   → assert created=true, api_key non-null, owner_user_id non-null

2. generateMagicLink(api_key, user_email=alice@test)
   → assert magic_link et auto_login_url non-null
   → assert expires_at > now + 30s

3. health(tenant_id=T1)
   → assert magic_link_capable=true
   → assert owner_attached=true
   → assert owner_email=alice@test

4. suspend(tenant_id=T1, reason=test)
   → health → assert status=suspended

5. resume(tenant_id=T1)
   → health → assert status=active

6. attach-owner(tenant_id=T1, owner_email=bob@test)
   → already_attached=false, role=owner
   → health → members_count=2 (alice + bob)

7. attach-owner(tenant_id=T1, owner_email=bob@test) [encore]
   → already_attached=true (idempotence)

8. provision(tenant_id=T1, owner_email=alice@test) [encore]
   → created=false, api_key même que step 1 (idempotence)
```

Ce test doit tourner en CI à chaque PR sur l'app downstream. Si rouge, le Hub ne déploie pas son client mis à jour.

## Sécurité

- **HMAC secret** : 32 bytes random, jamais loggué, rotaté tous les 6 mois.
- **Bearer webhook token** : 32 bytes random, rotation possible via X-Token-Version header.
- **Tenant API key** : générée par l'app, persistée chiffrée côté Hub (TODO P2), affichée jamais en logs.
- **Anti-replay HMAC** : timestamp drift max 5min, en plus de la signature.
- **Rate limit** : chaque app downstream limite à 10 req/s par signature HMAC source. Le Hub respecte un budget global de 100 req/s vers chaque app.

## Procédure d'onboarding nouvelle app

Quand une nouvelle app Veridian doit s'intégrer au Hub :

1. **Lire ce README intégralement.**
2. **Implémenter les 5 endpoints obligatoires** (provision, attach-owner, suspend, resume, health).
3. **Implémenter les webhooks vers Hub** avec les 5 événements obligatoires.
4. **Ajouter le test d'intégration** (scénario 1-8) en CI bloquant.
5. **Documenter dans son README** : nom de l'env var `HUB_API_SECRET`, format des erreurs spécifiques, conventions de slug `tenant_id`.
6. **Coordonner avec l'agent Hub** pour :
   - Provisionnement du secret HMAC (échange via `~/credentials/.all-creds.env`).
   - Ajout de l'app dans `Tenant.app` enum côté Hub Prisma.
   - Ajout du compose au DNS Cloudflare `*.app.veridian.site`.
   - Création du compose Dokploy.

## Roadmap intégrations en cours

| App | Statut | Manque |
|---|---|---|
| **Notifuse** | 🟡 Partiel (1-7 OK, 2 manquant, 5 manquant, webhooks partiels) | `attach-owner` + `health` + webhooks complets — cf [`notifuse-fix-2026-05-17.md`](./notifuse-fix-2026-05-17.md) |
| **Prospection** | 🟡 Partiel (1 OK custom, 2-5 manquants, webhooks 0) | Refacto vers contrat standard — cf [`prospection-align-2026-05-17.md`](./prospection-align-2026-05-17.md) |
| **Twenty** | ✅ Sortie de stack (2026-05-18) | — |
| **Analytics** | ⚪ À intégrer | Pas encore connecté au Hub. Roadmap P2. |
| **CMS** | ⚪ À intégrer | Pas encore connecté au Hub. Roadmap P2. |

## Évolutions à venir (v2)

- Endpoint `POST /api/tenants/{id}/transfer-owner` (atomique : retire old + ajoute new + log audit).
- Endpoint `GET /api/tenants/{id}/usage` standardisé (renvoie usage agrégé pour billing).
- Authentification SSO Hub → app : remplacer magic link par un OIDC stateless (économise un round-trip).
- Field `quota_limits` dans la response `provision` (l'app annonce ses limites, le Hub les stocke côté billing).
