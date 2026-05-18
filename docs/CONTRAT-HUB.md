# CONTRAT-HUB.md — Spec d'intégration des apps au Hub Veridian

> **Source de vérité** : ce fichier est gravé dans le marbre. Toute app branchée au
> Hub Veridian doit respecter ce contrat à 100 %. Les écarts sont de la dette
> trackée dans `veridian-infra/todo/TODO-LIVE.md`.
>
> **Audience** : agents Claude (Hub, Notifuse, Prospection, Analytics, CMS, futures
> apps), reviewers humains, Robert Brunon.
>
> **Compagnon** :
> - `veridian-infra/docs/saas-standards.md` — patterns cross-app (DB, auth, rôles,
>   audit log, soft delete). Ce contrat-ci **n'y duplique rien**, il pointe.
> - `CI-ARCHITECTURE.md` — pipeline CI/CD cross-app. Idem, pas de duplication.
>
> **Versionnage** : `v1` (2026-05-18). Toute évolution majeure → bump version + section
> "Changements" en bas.

---

## Table des matières

1. [Pourquoi ce contrat](#1-pourquoi-ce-contrat)
2. [Le modèle en 1 schéma](#2-le-modèle-en-1-schéma)
3. [Plans Veridian — matrice cross-app](#3-plans-veridian--matrice-cross-app)
4. [Flow signup utilisateur](#4-flow-signup-utilisateur)
5. [Endpoints obligatoires côté apps downstream](#5-endpoints-obligatoires-côté-apps-downstream)
6. [Authentification — 3 patterns](#6-authentification--3-patterns)
7. [Webhooks app → Hub](#7-webhooks-app--hub)
8. [Pilotage des plans depuis le Hub](#8-pilotage-des-plans-depuis-le-hub)
9. [Inventaire features payantes par app](#9-inventaire-features-payantes-par-app)
10. [Matrice de conformité](#10-matrice-de-conformité)
11. [Onboarding d'une nouvelle app](#11-onboarding-dune-nouvelle-app)
12. [Tests d'intégration exigés](#12-tests-dintégration-exigés)
13. [Versionnement et évolution](#13-versionnement-et-évolution)
14. [Changements](#14-changements)

---

## 1. Pourquoi ce contrat

Le Hub Veridian est l'**orchestrateur** du SaaS. Il owne :
- L'authentification utilisateur (Auth.js v5, signup centralisé)
- Le billing Stripe (1 customer humain, N subscriptions par app)
- Le provisioning à la demande des tenants côté apps downstream
- Le pilotage des plans (free → pro → enterprise + plans offerts manuels)
- Le routage auto-login (SSO Hub → app via magic link)

**Les apps downstream n'ont pas d'inscription publique.** Notifuse, Prospection,
Analytics, CMS ne sont **jamais** accessibles depuis une URL d'inscription. Tout
user humain passe par le Hub. Les apps reçoivent leurs tenants exclusivement via
le contrat HTTP documenté ici.

**Conséquence forte** : aucune app downstream ne stocke de mot de passe utilisateur.
Le password vit uniquement côté Hub (bcrypt). Les apps downstream authentifient les
users via **magic link uniquement** (pattern Notion / Vercel / Slack). Cf §6.

Si un agent ouvre une nouvelle session sur une app Veridian et trouve une page
`/signup` publique ou un champ password user dans la DB, c'est une faute
professionnelle à corriger immédiatement.

---

## 2. Le modèle en 1 schéma

```
                    ┌───────────────────────────┐
                    │   USER (browser)          │
                    └────┬──────────────────┬───┘
                         │ 1. signup        │ 5. click magic link
                         │ + login          │    (auto-login app)
                         ▼                  ▼
                    ┌─────────────────────────────┐
                    │   HUB (app.veridian.site)   │
                    │                             │
                    │  - Auth.js v5 session       │
                    │  - bcrypt password (only)   │
                    │  - Stripe billing           │
                    │  - DB hub_app.tenants       │
                    │  - DB hub_app.users         │
                    │  - DB hub_app.subscriptions │
                    └────┬────────────────────┬───┘
                         │ 2. provision       │ 4. generateMagicLink
                         │    (HMAC)          │    (Bearer api_key)
                         │ 3. update-plan     │
                         │    (HMAC)          │
                         │ 6. webhook events  │
                         ▼  (Bearer token)    │
                    ┌─────────────────────────────┐
                    │   APP DOWNSTREAM            │
                    │   (Notifuse / Prospection)  │
                    │                             │
                    │  - DB tenants/workspaces    │
                    │  - DB user_workspaces       │
                    │  - JWT session (post magic) │
                    │  - PAS de password user     │
                    └─────────────────────────────┘
```

**Note clé** : depuis 2026-05-18, le **provisioning est on-demand**. Le signup
Hub ne crée AUCUN tenant côté apps. L'user atterrit sur `/dashboard` et clique
"Commencer l'essai gratuit" sur chaque carte d'app indépendamment.

---

## 3. Plans Veridian — matrice cross-app

### 3.1 Règle générale

Chaque app downstream supporte **3 à 4 plans payants/freemium** + **3 plans offerts
typés**. Les plans payants sont propres à l'app (Notifuse a ses limites email,
Prospection a ses limites leads, etc.). Les plans offerts sont **identiques cross-app**
pour permettre un reporting unifié.

### 3.2 Plans payants par app (3-4 max, dont freemium obligatoire)

Chaque app déclare ses plans dans son fichier `config/plans.ts` (ou équivalent).
La liste **doit** être exposée au Hub via le code du client TypeScript du Hub
(ex: `veridian-hub/lib/notifuse/types.ts` pour Notifuse — `NOTIFUSE_PLANS` array).

**Convention de nommage** : minuscules, snake_case ou kebab-case stable.

| Slot | Rôle | Exemples acceptés |
|---|---|---|
| `freemium` ou `free` | Plan gratuit obligatoire — point d'entrée par défaut au provisioning | `free`, `freemium` |
| `starter` (optionnel) | Plan payant entrée de gamme | `starter`, `basic` |
| `pro` | Plan payant principal — cible 70 % des conversions | `pro`, `business` |
| `enterprise` | Plan payant haut de gamme — quotas étendus ou illimités | `enterprise`, `scale` |

**Une app ne PEUT PAS avoir plus de 4 plans payants/freemium.** Si tu veux plus
de granularité, fais des add-ons (workflow credits, extra seats) mais pas des
plans en plus.

### 3.3 Plans offerts (obligatoires, identiques cross-app)

Tout app doit supporter **AU MINIMUM ces 3 plans non-Stripe** :

| Plan | Quand l'utiliser | Quotas attendus |
|---|---|---|
| `lifetime_site_vitrine` | Client qui a acheté un site vitrine Veridian — l'app est incluse à vie dans la vente | Équivalent au plan `pro` payant de l'app |
| `lifetime_partner` | Partenaire bizdev qui doit accéder à l'app gratuitement | Équivalent à `pro` ou `enterprise` selon l'accord |
| `internal` | Comptes internes Veridian (Robert, démo prospect, tests E2E) | Quota illimité — **ne PAS appliquer de paywall** |

**Critique** : ces plans sont **immune aux webhooks Stripe**. Si une subscription
Stripe expire ou est canceled pour un tenant qui a `plan IN (lifetime_*, internal)`,
le webhook **ne doit pas** downgrade le tenant à `free`. C'est ce que Notifuse a
implémenté via `plan_source` (cf `veridian-hub/app/api/admin/notifuse/update-plan/route.ts:23`).
**Cette protection est obligatoire pour toute app downstream.**

### 3.4 Pricing target Robert (brainstorm, à figer plan par plan avec chaque agent)

> ⚠️ Section en cours d'élaboration — non figée. Chaque agent app doit remplir
> sa colonne et brainstormer avec Robert.

| App | Free | Starter | Pro | Enterprise |
|---|---|---|---|---|
| Notifuse | 1k emails/mois | À discuter | À discuter | À discuter |
| Prospection | 300 prospects | À discuter | À discuter | À discuter |
| Analytics | À définir | À définir | À définir | À définir |
| CMS | À définir | À définir | À définir | À définir |

**Bundle Veridian** (à concevoir post-brainstorm) : prix dégressif vs cumul des
plans individuels. Permet l'upsell "tu paies X pour Notifuse OU Y pour tout
Veridian (économise N €)". Spec à graver une fois validée avec Robert.

---

## 4. Flow signup utilisateur

### 4.1 Vue d'ensemble (post 2026-05-18)

```
1. User → POST app.veridian.site/api/auth/signup { email, password }
   → Hub crée hub_app.User (bcrypt password), AUCUN tenant downstream créé.

2. User redirigé vers /dashboard
   → Affiche cartes "Notifuse" / "Prospection" / etc. avec bouton
     "Commencer l'essai gratuit (15j)"

3. User click "Commencer l'essai gratuit" sur Notifuse
   → POST /api/tenants/start { app: "notifuse" }
   → Hub vérifie idempotence (court-circuit si déjà provisionné)
   → Hub appelle POST notifuse/api/tenants/provision (HMAC)
   → Notifuse crée workspace + user owner + api_key
   → Hub stocke api_key + workspace_id dans hub_app.tenants
   → Front ouvre l'auto_login_url dans nouvel onglet (TTL 60s)

4. User a un workspace Notifuse fonctionnel, trial 15j, plan "free".
   Ses prochains clics "Open Notifuse" depuis le Hub passent par
   POST notifuse/api/workspaces.generateMagicLink (Bearer api_key).
```

### 4.2 Endpoints Hub côté user

| Endpoint Hub | Auth | Rôle |
|---|---|---|
| `POST /api/auth/signup` | aucune | Créer compte Hub. Pas de provisioning. |
| `POST /api/auth/callback/credentials` | aucune | Login Auth.js v5 (cookie session JWT). |
| `POST /api/tenants/start { app }` | session user | Provisionner UNE app à la demande, idempotent. |
| `POST /api/tenants/retry` | session user | Re-tenter le provisioning si une app a échoué. |

### 4.3 Invariants

- **Le Hub ne stocke jamais le password d'un user en dehors de `hub_app.User.account.access_token` (hash bcrypt).** Aucune app downstream ne reçoit le password.
- **Le `tenant_id` est généré par le Hub** (UUID v4) et est la clé de jointure cross-app. Les apps utilisent ce `tenant_id` comme stable lookup pour leurs propres `workspace_id` internes.
- **Le user ne peut PAS provisionner pour quelqu'un d'autre.** `requireUser()` côté Hub garantit que `tenant_id` est lié au `userId` de la session.

---

## 5. Endpoints obligatoires côté apps downstream

Chaque app doit exposer ces endpoints sous le préfixe `/api/tenants/*` (ou
versionné `/api/v1/tenants/*` à partir du jour où on bumpe v2).

| # | Endpoint | Auth | Trigger | Obligatoire ? |
|---|---|---|---|---|
| 1 | `POST /api/tenants/provision` | HMAC Hub | User click "Commencer" | ✅ |
| 2 | `POST /api/tenants/update-plan` | HMAC Hub | Admin change plan / Stripe webhook | ✅ |
| 3 | `POST /api/tenants/attach-owner` | HMAC Hub | Hub répare un tenant cassé | ✅ |
| 4 | `POST /api/tenants/suspend` | HMAC Hub | Stripe webhook → past_due/canceled | ✅ |
| 5 | `POST /api/tenants/resume` | HMAC Hub | Stripe webhook → resumed | ✅ |
| 6 | `GET /api/tenants/{id}/health` | HMAC Hub | Cron Hub 1×/h ou check manuel | ✅ |
| 7 | `POST /api/workspaces.generateMagicLink` | Bearer api_key | User click "Open <App>" | ✅ |
| 8 | `DELETE /api/tenants/{id}` | HMAC Hub | Hard delete admin | ⚠️ Recommandé (sinon Hub ne peut pas supprimer un tenant) |

### 5.1 `POST /api/tenants/provision`

**Idempotent.** Si appelé 2× avec le même `tenant_id` + `owner_email`, retourne
`created: false` mais reste fonctionnel (magic_link régénéré).

**Request** :
```json
{
  "tenant_id": "string (UUID v4 généré par le Hub)",
  "owner_email": "string (email du user humain)",
  "workspace_name": "string (display name, max 32 chars)",
  "plan": "free|freemium|starter|pro|enterprise|lifetime_site_vitrine|lifetime_partner|internal",
  "metadata": {
    "hub_user_id": "string (User.id côté Hub)",
    "stripe_customer_id": "string (optionnel)"
  }
}
```

**Response 200** :
```json
{
  "tenant_id": "string (echo)",
  "workspace_id": "string (id app-side, peut différer)",
  "owner_user_id": "string (id du user owner côté app)",
  "owner_email": "string (echo)",
  "api_key": "string (à stocker côté Hub)",
  "api_key_email": "string (email technique de l'api_key)",
  "plan": "string (echo)",
  "created": true,
  "magic_link": "string (URL signin one-shot, TTL ~15min)",
  "auto_login_url": "string (URL self-contained, TTL ~60s)"
}
```

**Comportement obligatoire** :
- Crée l'`owner_email` comme `user` (jamais comme `api_key`) si pas déjà présent.
- Le user owner est attaché au workspace avec `role = "owner"`.
- L'`api_key` retournée est attachée au workspace avec `role = "member"` (pour les
  appels machine-to-machine du Hub plus tard).
- **Conflit owner** : si `tenant_id` existe avec un `owner_email` différent → 409
  Conflict, **jamais** d'écrasement silencieux.
- **Plan invalide** : 400 Bad Request avec la liste des plans supportés.

### 5.2 `POST /api/tenants/update-plan`

> 🔥 **Nouvel endpoint exigé suite à la feature pricing 2026-05-18**.

**Request** :
```json
{
  "tenant_id": "string",
  "plan": "string (un des plans supportés par l'app)",
  "plan_source": "stripe|manual|lifetime_site_vitrine|lifetime_partner|internal",
  "reason": "string (optionnel, audit trail)"
}
```

**Response 200** :
```json
{
  "tenant_id": "string (echo)",
  "plan": "string (echo)",
  "previous_plan": "string|null",
  "applied_at": "ISO8601"
}
```

**Comportement critique** :
- Si `plan_source = "stripe"` et que le tenant a un `plan_source` actuel dans
  `("lifetime_site_vitrine", "lifetime_partner", "internal")` → **REJET** (409
  Conflict). Stripe ne peut pas downgrade un plan offert manuellement.
- Si `plan_source = "manual"` → l'admin Hub écrase tout. Stocker `plan_source`
  pour bloquer les downgrades Stripe futurs.
- Audit : append dans une table `veridian_plan_history` ou équivalent (au moins
  les 50 derniers changements gardés).

### 5.3 `POST /api/tenants/attach-owner`

Suite au bug Notifuse 2026-05-17 où des tenants existaient sans owner humain
attaché → magic links cassés.

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

**Comportement** :
- User n'existe pas → créer (`type: user`, sans password, sans email vérifié).
- Existe avec le bon role → `already_attached: true`.
- Existe avec un role différent → upgrade au role demandé.
- **Additif uniquement** : on ne retire jamais un owner existant. Pour transfert
  d'ownership, utiliser un futur endpoint `transfer-owner` (roadmap v2).

### 5.4 `POST /api/tenants/suspend` et `POST /api/tenants/resume`

**Suspend** :
```json
// Request
{ "tenant_id": "string", "reason": "billing_past_due|admin_action|quota_exceeded" }

// Response 200
{ "tenant_id": "string", "suspended_at": "ISO8601" }
```

**Comportement suspend** : marquer le tenant comme suspendu, bloquer tout accès
écriture côté app, **NE PAS** supprimer la data.

**Resume** :
```json
// Request
{ "tenant_id": "string" }

// Response 200
{ "tenant_id": "string", "resumed_at": "ISO8601" }
```

Annule l'effet de `suspend`. Idempotent.

### 5.5 `GET /api/tenants/{id}/health`

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
  "plan": "string",
  "checked_at": "ISO8601"
}
```

**`magic_link_capable: false`** doit être renvoyé si :
- Pas d'owner humain attaché (cas du bug Notifuse).
- API key révoquée.
- Tenant soft-deleted.

Le Hub appelle cet endpoint en cron horaire pour les tenants actifs et stocke
le résultat (table `hub_app.tenant_health_check` à créer côté Hub, roadmap P2).

### 5.6 `POST /api/workspaces.generateMagicLink`

**Auth** : `Authorization: Bearer <tenant_api_key>` (pas HMAC).

**Request** : `{ "user_email": "string" }`

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

L'`api_key` **doit être scoped à un seul workspace** côté app. Si l'app détecte
qu'une api_key est partagée entre workspaces → 409 systématique.

---

## 6. Authentification — 3 patterns

### 6.1 Pattern A — HMAC Hub (machine-to-machine)

Pour tout endpoint Hub → app sous identité Hub (provision, update-plan,
suspend, resume, attach-owner, health, delete).

**Headers** :
```
X-Veridian-Timestamp: <unix_ms>
X-Veridian-Hub-Signature: <hex(hmac_sha256(secret, "{timestamp}.{raw_body}"))>
Content-Type: application/json
```

**Vérification côté app** :
1. Reject si `|now - timestamp| > 5min` (anti-replay)
2. Recompute `hmac_sha256(HUB_API_SECRET, timestamp + "." + raw_body)`
3. Compare en **temps constant** (`crypto.timingSafeEqual` en Node,
   `hmac.Equal` en Go, équivalent dans tout autre langage)

Le secret `HUB_API_SECRET` est généré au provisioning de l'app et stocké :
- Côté Hub : `~/credentials/.all-creds.env` + ENV var `<APP>_HUB_API_SECRET`
- Côté app : `.env` + ENV var `HUB_API_SECRET`

**Rotation** : tous les 6 mois. Procédure de bascule via variable `HUB_API_SECRET_NEXT`
acceptée en parallèle pendant 24h. Coordonné par l'agent Hub.

### 6.2 Pattern B — Bearer api_key tenant (Hub user-to-app)

Pour `generateMagicLink` uniquement. Le Hub a stocké l'`api_key` reçue au
provisioning et la présente lors de la génération de magic links pour ce tenant.

**Headers** :
```
Authorization: Bearer <tenant_api_key>
Content-Type: application/json
```

**Scoping** : 1 api_key = 1 workspace. Jamais de partage.

### 6.3 Pattern C — Bearer Hub webhook token (app → Hub)

Pour les webhooks app → Hub. Token statique unique par app.

**Headers (app → Hub)** :
```
Authorization: Bearer <HUB_WEBHOOK_TOKEN_<APP>>
Content-Type: application/json
```

Stocké :
- Côté app : `.env` ENV var `HUB_WEBHOOK_TOKEN`
- Côté Hub : ENV var `<APP>_WEBHOOK_TOKEN`

### 6.4 Ce qu'on NE fait pas

- **Pas d'OAuth** entre Hub et apps. Trop lourd pour un usage machine-to-machine
  contrôlé.
- **Pas de JWT signé entre apps**. Le HMAC suffit, plus simple à rotater.
- **Pas de password user partagé**. Le Hub bcrypt côté lui, les apps font magic
  link only. Cf §1.

---

## 7. Webhooks app → Hub

Endpoint Hub : `POST https://app.veridian.site/api/webhooks/<app_name>`

`<app_name>` ∈ `notifuse`, `prospection`, `analytics`, `cms`, ...

### 7.1 Événements obligatoires

| Event | Quand | Payload `data` |
|---|---|---|
| `tenant.suspended` | App suspend localement (quota, admin) | `{suspended_at, reason}` |
| `tenant.resumed` | App resume localement | `{resumed_at}` |
| `tenant.deleted` | App hard-delete localement | `{deleted_at}` |
| `tenant.owner_changed` | App change l'owner (admin action) | `{old_owner_email, new_owner_email}` |
| `tenant.quota_exceeded` | Soft alert (pas blocking) | `{quota_type, current, limit}` |

### 7.2 Format payload standard

```json
{
  "event": "tenant.suspended",
  "tenant_id": "string",
  "occurred_at": "ISO8601",
  "data": { ... },
  "idempotency_key": "string (uuid v4)"
}
```

### 7.3 Comportement Hub

- `200 OK` si reçu et traité.
- `409 Conflict` si `idempotency_key` déjà traité dans les dernières 24h.
- `400 Bad Request` si payload invalide.
- Pour `5xx` côté Hub : l'app **doit retenter** avec backoff exponentiel (1s, 2s,
  4s, ..., max 1h). Hub idempotent sur la `idempotency_key`.

---

## 8. Pilotage des plans depuis le Hub

### 8.1 Endpoints admin Hub (livrés 2026-05-18)

| Endpoint | Auth | Rôle |
|---|---|---|
| `POST /api/admin/tenants/[id]/plan` | requireAdmin | Update plan + propagation app (HMAC) |
| `POST /api/admin/grant-plan` | requireAdmin | Legacy alias — deprecated, à dégager |
| `GET /api/admin/list-tenants` | requireAdmin | Liste tenants + plans actuels par app |

### 8.2 Body `POST /api/admin/tenants/[id]/plan`

```json
{
  "app": "notifuse|prospection|analytics|cms",
  "plan": "string (un plan supporté par l'app cible)",
  "trialEndsAt": "ISO8601|null (optionnel)",
  "reason": "string (optionnel, audit)"
}
```

**Comportement** :
1. Valide `plan` contre la liste des plans supportés par l'app.
2. Écrit `<app>Plan` dans `hub_app.tenants` (colonne typée — pas en JSON metadata).
3. Si l'app expose `/api/tenants/update-plan` HMAC → propage en synchrone.
4. Sinon → écrit côté Hub uniquement et retourne `warning` explicite.
5. Met à jour `trialEndsAt` si fourni (peut être `null` = free pour toujours).
6. Audit : 50 derniers changements dans `metadata.<app>_plan_history`.

### 8.3 Cas d'usage business

| Cas | Action |
|---|---|
| Robert vend un site vitrine, veut offrir Notifuse Pro à vie | `POST .../plan { app: "notifuse", plan: "lifetime_site_vitrine", trialEndsAt: null }` |
| Partenaire bizdev à qui on offre Prospection Pro 1 an | `POST .../plan { app: "prospection", plan: "lifetime_partner", trialEndsAt: "2027-05-18T..." }` |
| Compte interne Veridian (démo / E2E) | `POST .../plan { app: "notifuse", plan: "internal", trialEndsAt: null }` |
| Client paye Stripe, webhook → upgrade pro | Webhook handler → `POST .../plan { app: "notifuse", plan: "pro", plan_source: "stripe" }` (futur) |
| Admin downgrade un client problématique | UI admin Hub → dropdown → POST |

### 8.4 Roadmap pilotage

- ✅ Endpoint unifié `/api/admin/tenants/[id]/plan` (livré 2026-05-18)
- ✅ UI admin tenants avec 2 dropdowns plan + trial editable (livré 2026-05-18)
- ⚪ Endpoint programmatic `POST /api/external/tenants/<id>/plan` avec API key
  externe (pour scripts d'automatisation hors session admin web — à concevoir)
- ⚪ Webhook Stripe → mapping automatique `stripe_price_id` → `plan` côté Hub
  (aujourd'hui partiel dans `utils/stripe/prisma-sync.ts`)

---

## 9. Inventaire features payantes par app

> 🚧 Section à remplir par chaque agent d'app. Le template ci-dessous est figé,
> chaque agent rédige sa colonne.

### 9.1 Template obligatoire pour chaque app

Chaque app doit déclarer dans `<app>/docs/features-by-plan.md` :

```markdown
# Features par plan — <App Name>

## Plans supportés
- free / pro / enterprise (+ lifetime_*, internal)

## Matrice features × plans

| Feature | free | pro | enterprise | lifetime_* | internal |
|---|---|---|---|---|---|
| Quota X | 1000 | 50000 | illimité | = pro | illimité |
| Feature Y | ❌ | ✅ | ✅ | ✅ | ✅ |
| Feature Z | ❌ | ❌ | ✅ | ✅ | ✅ |

## Enforcement
- Code paywall : `<app>/lib/paywall.ts` (helper `requireActivePlan(tenantId)`)
- Middleware : retourne 402 Payment Required sur endpoints payants si plan
  insuffisant
- UI : composant `<UpgradePrompt feature="X" />` affiche le CTA upgrade vers
  l'URL Hub `/pricing`
```

### 9.2 État actuel par app

| App | features-by-plan.md | Paywall code | Statut |
|---|---|---|---|
| **Notifuse** | ⚪ À rédiger | Existant (`PlanQuotas` map dans `internal/domain/veridian.go`) | Quotas emails OK, autres features à figer |
| **Prospection** | ⚪ À rédiger | Partiel — `PLAN_LIMITS` dans config mais paywall non systématique | À aligner |
| **Analytics** | ⚪ À rédiger | Inexistant — pas encore monétisé | Roadmap P2 |
| **CMS** | ⚪ À rédiger | Inexistant | Roadmap P2 |

### 9.3 Process d'ajout d'une feature payante

1. L'agent app propose la feature + son enforcement dans son `features-by-plan.md`.
2. Brainstorm avec Robert sur les plans qui débloquent la feature + impact pricing.
3. L'agent Hub valide la cohérence cross-app (ex: une feature qui débloque dans
   Notifuse `pro` doit aussi être dans `lifetime_site_vitrine` car Pro = vente
   incluse).
4. PR sur l'app + mise à jour de la matrice dans ce contrat (§9.2).

---

## 10. Matrice de conformité

> ⚠️ Cette section est mise à jour à chaque ship cross-app. Toute valeur ❌ doit
> être trackée dans `veridian-infra/todo/TODO-LIVE.md`.

### 10.1 Endpoints downstream

| Endpoint | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| 1. `POST provision` | ✅ | ⚠️ HMAC custom à migrer | ❌ | ❌ |
| 2. `POST update-plan` | ✅ | ❌ | ❌ | ❌ |
| 3. `POST attach-owner` | ✅ | ❌ | ❌ | ❌ |
| 4. `POST suspend` | ⚠️ Partiel | ❌ | ❌ | ❌ |
| 5. `POST resume` | ⚠️ Partiel | ❌ | ❌ | ❌ |
| 6. `GET health` | ✅ | ❌ | ❌ | ❌ |
| 7. `POST generateMagicLink` | ✅ | ⚠️ Custom (`regenerate-login`) | ❌ | ❌ |
| 8. `DELETE tenant` | ⚠️ Partiel | ❌ | ❌ | ❌ |

### 10.2 Plans supportés

| Plan | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| `free` / `freemium` | ✅ `free` | ✅ `freemium` | ❌ | ❌ |
| `starter` | ❌ | ⚠️ Listé Hub, pas implémenté | ❌ | ❌ |
| `pro` | ✅ | ✅ | ❌ | ❌ |
| `business` | ✅ | ❌ | ❌ | ❌ |
| `enterprise` | ✅ | ✅ | ❌ | ❌ |
| `lifetime_site_vitrine` | ✅ | ❌ | ❌ | ❌ |
| `lifetime_partner` | ✅ | ❌ | ❌ | ❌ |
| `internal` | ✅ | ❌ | ❌ | ❌ |

### 10.3 Webhooks app → Hub

| Event | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| `tenant.suspended` | ⚠️ Partiel | ❌ | — | — |
| `tenant.resumed` | ⚠️ Partiel | ❌ | — | — |
| `tenant.deleted` | ⚠️ Partiel | ❌ | — | — |
| `tenant.owner_changed` | ❌ | ❌ | — | — |
| `tenant.quota_exceeded` | ❌ | ❌ | — | — |

### 10.4 Auth & sécurité

| Item | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| HMAC standard `{ts}.{body}` | ✅ | ⚠️ Custom `email:ts` | — | — |
| Anti-replay timestamp 5min | ✅ | ⚠️ À vérifier | — | — |
| Comparaison temps constant | ✅ | ⚠️ À vérifier | — | — |
| Pas de password user en DB | ✅ | ✅ | — | — |
| Magic link only auth | ✅ | ✅ | — | — |

### 10.5 Tests d'intégration

| Test | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| Scénario provision idempotent | ✅ | ⚠️ À vérifier | — | — |
| Scénario attach-owner | ✅ | ❌ | — | — |
| Scénario suspend/resume cycle | ⚠️ Partiel | ❌ | — | — |
| Scénario health avant/après attach | ✅ | ❌ | — | — |

---

## 11. Onboarding d'une nouvelle app

Procédure à suivre pour intégrer une nouvelle app (Analytics, CMS, ou future) au
Hub Veridian :

### 11.1 Pré-requis côté app

- [ ] App déployée et accessible sur `<app>.app.veridian.site` (DNS Cloudflare).
- [ ] App a sa propre DB (pas de partage avec Hub ou autre app).
- [ ] App expose un endpoint `/api/health` qui retourne 200.

### 11.2 Implémenter le contrat

- [ ] Lire **intégralement** ce fichier `CONTRAT-HUB.md`.
- [ ] Implémenter les 8 endpoints obligatoires (§5).
- [ ] Implémenter les 5 événements webhook vers Hub (§7).
- [ ] Implémenter les plans payants + 3 plans offerts obligatoires (§3).
- [ ] Rédiger `<app>/docs/features-by-plan.md` (§9).
- [ ] Ajouter test d'intégration scénario complet (§12) en CI bloquant.

### 11.3 Coordonner avec l'agent Hub

L'agent Hub doit :
- [ ] Générer le `HUB_API_SECRET` (32 bytes random).
- [ ] Stocker côté `~/credentials/.all-creds.env` + GitHub Secrets.
- [ ] Ajouter l'app dans le code client du Hub (`veridian-hub/lib/<app>/client.ts`).
- [ ] Ajouter une colonne `<app>Plan` dans `hub_app.tenants` (migration Prisma).
- [ ] Ajouter `<app>` dans la liste `app` du body `/api/tenants/start` et
      `/api/admin/tenants/[id]/plan`.
- [ ] Ajouter la carte côté dashboard `/dashboard/page.tsx`.
- [ ] Compléter la matrice de conformité §10 de ce fichier.

### 11.4 Validation

- [ ] CI app verte (avec test scénario contrat).
- [ ] Smoke E2E manuel : signup Hub → start app → provisioning → magic link →
      change plan admin → verify health.
- [ ] Documentation mise à jour dans ce contrat (§10).

---

## 12. Tests d'intégration exigés

Chaque app downstream doit avoir, en CI bloquant, un test d'intégration qui
valide le scénario complet :

```
1. provision(tenant_id=T1, owner_email=alice@test, plan=free)
   → assert created=true, api_key non-null, owner_user_id non-null

2. provision(tenant_id=T1, owner_email=alice@test) [replay]
   → assert created=false, api_key === step 1, owner_user_id === step 1

3. provision(tenant_id=T1, owner_email=bob@test) [conflit owner]
   → assert HTTP 409

4. generateMagicLink(api_key, user_email=alice@test)
   → assert magic_link et auto_login_url non-null
   → assert expires_at > now + 30s

5. health(tenant_id=T1)
   → assert magic_link_capable=true
   → assert owner_attached=true
   → assert owner_email=alice@test
   → assert plan=free

6. update-plan(tenant_id=T1, plan=pro, plan_source=stripe)
   → health → assert plan=pro

7. update-plan(tenant_id=T1, plan=lifetime_site_vitrine, plan_source=lifetime_site_vitrine)
   → health → assert plan=lifetime_site_vitrine

8. update-plan(tenant_id=T1, plan=free, plan_source=stripe) [test immunité]
   → assert HTTP 409 (un plan_source=lifetime_* immune les downgrades Stripe)
   → health → assert plan toujours lifetime_site_vitrine

9. update-plan(tenant_id=T1, plan=free, plan_source=manual) [test override admin]
   → assert HTTP 200
   → health → assert plan=free

10. suspend(tenant_id=T1, reason=test)
    → health → assert status=suspended

11. resume(tenant_id=T1)
    → health → assert status=active

12. attach-owner(tenant_id=T1, owner_email=charlie@test)
    → already_attached=false, role=owner
    → health → members_count=2

13. attach-owner(tenant_id=T1, owner_email=charlie@test) [replay]
    → already_attached=true (idempotence)
```

**Localisation suggérée du test** :
- Notifuse : `tests/integration/hub_contract_test.go`
- Prospection : `__tests__/integration/hub-contract.test.ts`
- Analytics / CMS / futurs : équivalent dans leur stack

**Le test doit pouvoir tourner contre l'app déployée en staging** (HUB_API_SECRET
de staging) pour permettre des E2E réels en plus des unit tests.

---

## 13. Versionnement et évolution

### 13.1 Politique de versionning

- **Ajout de champs response** : OK sans bump (le Hub fait optional chaining).
- **Ajout d'endpoints obligatoires** : bump minor (v1.1, v1.2...). Délai de
  grâce 2 semaines pour compliance.
- **Breaking change endpoint existant** : bump major (v2) + endpoints `/api/v2/...`
  en parallèle pendant 1 mois. Le Hub bascule progressivement avec feature flag.
- **Suppression d'endpoint** : 3 mois de préavis + path `/api/v1/...` deprecated.

### 13.2 Process d'évolution

1. Un agent (Hub ou app) propose un changement via PR sur ce fichier
   `CONTRAT-HUB.md`.
2. Brief à Robert avec impact business + technique.
3. Validation Robert → merge sur main.
4. Tickets automatiquement déposés dans `<app>/todo/` pour chaque app impactée.
5. Suivi de compliance dans §10 de ce fichier.

### 13.3 Compatibilité backward

Aucune app downstream ne PEUT casser un comportement décrit dans une version
précédente sans :
- Bumper la version major (v2 endpoints en parallèle).
- Coordonner explicitement avec l'agent Hub.
- Donner 1 mois minimum pour la bascule.

---

## 14. Changements

### v1 — 2026-05-18

- Initial. Récupère et grave le contrat précédemment dans
  `veridian-hub/todo/integrations/README.md`.
- Ajout §3 (matrice plans cross-app avec plans offerts typés).
- Ajout §4 (flow signup utilisateur post-bascule on-demand).
- Ajout §5.2 (`POST /api/tenants/update-plan` obligatoire).
- Ajout §8 (pilotage admin des plans, endpoints livrés).
- Ajout §9 (template features-by-plan par app).
- Ajout §10 (matrice de conformité).
- Ajout §11 (procédure onboarding nouvelle app).
- Ajout test scénario 6-9 dans §12 (immunité plans offerts vs Stripe).
