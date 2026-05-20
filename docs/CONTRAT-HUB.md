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
> **Versionnage** : `v1.3` (2026-05-19). Toute évolution majeure → bump version + section
> "Changements" en bas.
>
> 🔥 **Règle absolue (gravée en v1.1)** : tout ce qui est décrit dans ce contrat
> fait l'objet d'un **contrôle accru en CI ET d'un smoke manuel via navigateur
> avant prod**. Cf §11.5 (Contrôle qualité obligatoire).
>
> 🔥 **Responsabilité agent (gravée en v1.2)** : un agent app qui s'écarte du
> contrat (invente un pattern non spécifié, choisit un default différent de
> celui gravé ici) doit **soit** ouvrir un ticket dans `veridian-hub/todo/`
> pour discussion, **soit** documenter explicitement l'écart dans son PR.
> Implémenter "à l'arrache parce que pas spécifié" est une faute professionnelle.
> Les defaults ci-dessous sont conservateurs et toujours sûrs en première
> implémentation.

---

## Table des matières

1. [Pourquoi ce contrat](#1-pourquoi-ce-contrat)
2. [Le modèle en 1 schéma](#2-le-modèle-en-1-schéma)
3. [Plans Veridian — matrice cross-app](#3-plans-veridian--matrice-cross-app)
   - 3.5 [Multi-membre = feature payante (v1.3)](#35-multi-membre--feature-payante-gravé-v13)
   - 3.6 [Apps self-serve vs client_only (v1.3)](#36-apps-self-serve-vs-apps-shadow-marketing-gravé-v13)
4. [Flow signup utilisateur](#4-flow-signup-utilisateur)
5. [Endpoints obligatoires côté apps downstream](#5-endpoints-obligatoires-côté-apps-downstream)
   - 5.1–5.6 Endpoints standards
   - 5.7 [Cycle de vie tenant](#57-cycle-de-vie-tenant-machine-à-états)
   - 5.8 [Endpoints lifecycle (soft-delete / restore / purge / touch / usage-summary)](#58-endpoints-lifecycle)
   - 5.9 [Mode dégradé paywall obfusqué cross-app](#59-mode-dégradé-paywall-obfusqué)
   - 5.10 [Format d'erreurs standardisé](#510-format-derreurs-standardisé)
   - 5.11 [Idempotency-Key header](#511-idempotency-key-header)
   - 5.12 [Lookup user data depuis l'app (v1.2)](#512-lookup-user-data-depuis-lapp-downstream)
   - 5.13 [Localisation / i18n (v1.2)](#513-localisation--i18n)
   - 5.14 [Lookup runtime plan + cache + désync (v1.2)](#514-lookup-runtime-du-plan-tenant-côté-app-cache--invalidation)
   - 5.15 [Rotation api_key (v1.2)](#515-rotation-api_key-tenant)
   - 5.16 [Transfer ownership (v1.2)](#516-transfert-downership)
   - 5.17 [Quotas exposés au provision (v1.2)](#517-quotas-exposés-à-lapp-au-provisioning)
   - 5.18 [Sync membres tenant cross-app — Option C (v1.3)](#518-sync-des-membres-tenant-cross-app-option-c)
   - 5.19 [Retrait d'un membre (v1.3)](#519-retrait-dun-membre)
   - 5.20 [Restauration d'un membre (v1.3)](#520-restauration-dun-membre)
   - 5.21 [Seat overage — soft warning 7j (v1.3)](#521-seat-overage--soft-warning-7-jours)
6. [Authentification — 3 patterns](#6-authentification--3-patterns)
   - 6.5 [Convention env vars staging / prod](#65-convention-env-vars-stagingprod)
   - 6.6 [Mode dev local (SKIP_HMAC)](#66-mode-dev-local-skip_hmac)
6bis. [Autologin SSO-stack Veridian (3 couches)](#6bis-autologin-sso-stack-veridian-3-couches)
   - 6bis.1 [Vue d'ensemble — 3 couches dégradées](#6bis1-vue-densemble--3-couches-dégradées)
   - 6bis.2 [Couche 2 — détails techniques](#6bis2-couche-2--détails-techniques)
   - 6bis.3 [Couche 3 — détails techniques](#6bis3-couche-3--détails-techniques)
   - 6bis.6 [État au 2026-05-20](#6bis6-état-au-2026-05-20)
7. [Webhooks app → Hub](#7-webhooks-app--hub)
   - 7.4 [Stripe → Hub → apps chaîne billing (v1.2)](#74-stripe--hub--apps-chaîne-billing-complète)
8. [Pilotage des plans + lifecycle depuis le Hub](#8-pilotage-des-plans-depuis-le-hub)
   - 8.5 [Admin lifecycle panel](#85-admin-lifecycle-panel)
   - 8.6 [Restriction réseau admin (Tailscale)](#86-restriction-réseau-admin-tailscale)
   - 8.7 [Config lifecycle ENV Hub](#87-config-lifecycle-env-hub)
   - 8.8 [Migration tenants existants vers v1.x (v1.2)](#88-migration-des-tenants-existants-vers-v1x)
   - 8.9 [Shadow marketing apps (v1.3)](#89-affichage-shadow-marketing-pour-les-apps-client_only)
9. [Inventaire features payantes par app](#9-inventaire-features-payantes-par-app)
10. [Matrice de conformité](#10-matrice-de-conformité)
11. [Onboarding d'une nouvelle app](#11-onboarding-dune-nouvelle-app)
    - 11.5 [Contrôle qualité obligatoire (CI + smoke manuel navigateur)](#115-contrôle-qualité-obligatoire-règle-absolue)
12. [Tests d'intégration exigés](#12-tests-dintégration-exigés)
13. [Observabilité et logs standards](#13-observabilité-et-logs-standards)
14. [Versionnement et évolution](#14-versionnement-et-évolution)
    - 14.4 [Concurrent modification — optimistic locking (v1.2)](#144-concurrent-modification-optimistic-locking)
15. [Roadmap angles morts identifiés (v1.2)](#15-roadmap-angles-morts-identifiés)
16. [Changements](#16-changements)

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

### 3.5 Multi-membre = feature payante (gravé v1.3)

> 🔥 Décision business 2026-05-19 : la notion de membre additionnel est **réservée
> aux plans payants**. Free/freemium = 1 user solo (le owner). Tout invité
> nécessite un upgrade.

**Quota seats par tier** (gravé dans `lib/pricing/plans.ts` champ `members_seats`) :

| Tier | Seats inclus (owner compris) | Apps cross-app |
|---|---|---|
| `free` / `freemium` | **1** (owner solo) | Notifuse free, Prospection free |
| `starter` (optionnel) | 1 ou 2 selon app | — |
| `pro` | **5** | Notifuse pro, Prospection pro, Veridian pro bundle |
| `business` / `enterprise` | **25** | Notifuse business, Prospection enterprise, Veridian business bundle |
| `lifetime_site_vitrine` | 5 (équivalent pro) | toutes apps |
| `lifetime_partner` | 25 (équivalent business) | toutes apps |
| `internal` | `unlimited` | toutes apps |

**Règle clé** : le quota seats est **cross-app**. Un user invité sur le tenant a
accès à TOUTES les apps souscrites par le tenant. Si l'user A invite B sur un
plan Veridian Pro, B voit Notifuse ET Prospection avec son magic link Hub.

Cf §5.18 pour l'endpoint `invite-member` Hub qui applique le quota.

### 3.6 Apps self-serve vs apps "shadow marketing" (gravé v1.3)

> 🔥 Décision business 2026-05-19 : les apps Veridian se répartissent en deux
> catégories selon le mode d'acquisition client.

**Apps self-serve** (`self_serve: true` dans le catalogue) :
- L'user peut s'inscrire au Hub, choisir un plan, payer via Stripe Checkout.
- Visibles **actives** dans le Hub Dashboard.
- Exemple : **Notifuse**, **Prospection**.

**Apps "client_only"** (`client_only: true` dans le catalogue) :
- L'app n'est PAS accessible via signup Hub direct.
- Réservée aux **clients qui ont acheté un site vitrine Veridian** (offert dans
  la vente, plan `lifetime_site_vitrine`).
- Visibles **grisées** dans le Hub Dashboard pour tout autre user, avec badge
  "Inclus avec un site Veridian".
- Au click : **modal explicative** + CTA vers `https://veridian.site/sites`
  (page marketing).
- Exemple : **Analytics**, **CMS**.

Cf §8.9 pour l'implémentation côté Hub Dashboard.

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

### 5.7 Cycle de vie tenant (machine à états)

> 🔥 Gravé en v1.1 (2026-05-18). Source de vérité absolue du flow lifecycle.

```
                       [tenants.status × tenants.deleted_at × tenants.purge_eligible_at]

         (no row)
            │
            │ POST /api/tenants/start  (user click "Commencer essai")
            ▼
        ┌──────────┐
        │  active  │◀────────────────────────┐
        └────┬─────┘                         │
             │                               │ resume
             │ suspend (Stripe past_due,     │
             │          admin action,        │
             │          quota exceeded)      │
             ▼                               │
        ┌──────────────┐                     │
        │  suspended   │─────────────────────┘
        └────┬─────────┘
             │
             │ soft_delete (admin OU Stripe canceled OU trial expired confirmé)
             ▼
        ┌─────────────────────────────────────────────┐
        │  soft_deleted                               │
        │                                             │
        │  - tenants.deleted_at = NOW()               │
        │  - tenants.purge_eligible_at =              │
        │      NOW() + SOFT_DELETE_GRACE_DAYS         │
        │  - data INTACTE côté app                    │
        │  - accès user = paywall obfusqué (§5.9)     │
        │  - écritures bloquées                       │
        └────┬────────────────────────────────────────┘
             │
             │ ┌─────────────────────────────────────┐
             │ │ TOUCH (webhook tenant.touched)      │
             │ │ User détecté actif → repousse :     │
             │ │ purge_eligible_at =                 │
             │ │   NOW() + TOUCH_RESET_DAYS          │
             │ └─────────────────────────────────────┘
             │
             │ restore (admin click "Restore" — annule soft_delete)
             ▼
        ┌──────────────┐
        │  suspended   │  (l'admin doit ensuite resume manuellement)
        └──────────────┘

             OU si purge_eligible_at < NOW() ET aucun touch :
             ▼
        ┌──────────────────┐
        │  purge_eligible  │  visible dans /dashboard/admin/lifecycle
        │                  │  countdown vert/orange/rouge
        │                  │  ATTEND une action HUMAINE
        └────┬─────────────┘
             │
             │ purge (admin click "Purger maintenant" + confirm slug)
             │ JAMAIS via cron, JAMAIS auto.
             ▼
        ┌──────────┐
        │  purged  │  ligne DB conservée (audit), data effacée côté apps
        └──────────┘     status='purged', tous champs data-related = NULL
```

**Règles dures gravées** :

1. **Aucune transition automatique vers `purged`.** Seul un humain (Robert, ou
   un agent sur ordre explicite de Robert) déclenche `purge`. Aucun cron.
2. **`soft_delete` est immédiat et réversible** pendant toute la fenêtre
   `purge_eligible_at - now`.
3. **`restore` ramène vers `suspended`**, jamais directement vers `active`. C'est
   à l'admin de juger s'il faut `resume`.
4. **Le mécanisme `touch`** (§5.8.4) repousse `purge_eligible_at` à chaque
   signe de vie qualifié (cf §5.8.4 pour la définition exacte de "qualifié").
   Un tenant qui montre des signes de vie n'est jamais purgeable.
5. **Pendant `soft_deleted`, l'app reste accessible** mais en mode dégradé
   paywall obfusqué (§5.9). Le user voit son contenu floutés, peut payer
   pour réactiver, contacter le support.
6. **Stripe n'a aucun pouvoir de purge.** Un Stripe `subscription.deleted` peut
   au maximum déclencher `soft_delete`, jamais `purge`.
7. **Les plans `lifetime_*` et `internal` sont immune au `soft_delete` automatique
   par Stripe** (cf §3.3 immunité plan_source).

**Transitions légales** (un agent qui veut implémenter ça doit respecter cette
table — toute autre transition = 409 Conflict côté Hub et côté apps) :

| Depuis ↓ Vers → | active | suspended | soft_deleted | purge_eligible | purged |
|---|---|---|---|---|---|
| `(no row)` | ✅ provision | ❌ | ❌ | ❌ | ❌ |
| `active` | — | ✅ suspend | ✅ soft_delete | ❌ | ❌ |
| `suspended` | ✅ resume | — | ✅ soft_delete | ❌ | ❌ |
| `soft_deleted` | ❌ | ✅ restore | — | ✅ auto (timer) | ❌ |
| `purge_eligible` | ❌ | ✅ restore | ✅ auto (touch) | — | ✅ purge (humain) |
| `purged` | ❌ | ❌ | ❌ | ❌ | — |

### 5.8 Endpoints lifecycle

Tous obligatoires en v1.1. Tous sous HMAC Hub (§6.1). Remplacent le `DELETE
/api/tenants/{id}` ambigu de v1.

#### 5.8.1 `POST /api/tenants/{id}/soft-delete`

**Request** :
```json
{
  "tenant_id": "string",
  "reason": "admin_action|stripe_canceled|trial_expired|abuse|user_request",
  "purge_eligible_at": "ISO8601 (calculé par Hub via SOFT_DELETE_GRACE_DAYS)"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "soft_deleted_at": "ISO8601",
  "purge_eligible_at": "ISO8601 (echo)",
  "previous_status": "active|suspended"
}
```

**Comportement obligatoire côté app** :
- Marquer `deleted_at = NOW()` sur la ligne tenant/workspace.
- **NE PAS supprimer** la data (emails, leads, settings, owner, api_key, etc.).
- **Toutes les routes API en lecture** doivent désormais appliquer le mode
  dégradé §5.9 (obfuscation serveur des champs sensibles).
- **Toutes les routes API en écriture** doivent retourner `402 Payment Required`
  avec le body standard §5.10 (`{ error: "tenant_soft_deleted", upgrade_url: "<hub_pricing_url>" }`).
- L'`api_key` reste **valide pour le Hub** (`generateMagicLink` continue de
  fonctionner — c'est ce qui permet à l'user de revenir voir son paywall).
- Le user qui consomme un magic link reçoit une session JWT normale, mais
  toutes ses requêtes sont en mode dégradé.

**Idempotent** : si déjà `soft_deleted`, retourne 200 avec les valeurs actuelles
(no-op).

#### 5.8.2 `POST /api/tenants/{id}/restore`

**Request** :
```json
{
  "tenant_id": "string",
  "reason": "string (optionnel, audit)"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "restored_at": "ISO8601",
  "new_status": "suspended"
}
```

**Comportement** :
- Mettre `deleted_at = NULL`, `purge_eligible_at = NULL`.
- **Passer en `suspended`** (pas `active` — c'est à l'admin de resume manuellement).
- Lever toutes les obfuscations §5.9.
- Lever tous les blocages en écriture.

**Idempotent** : si déjà restauré, retourne 200.

**Erreur** : `409 Conflict` avec body `{ error: "tenant_not_soft_deleted" }` si
le tenant n'est pas en `soft_deleted`.

#### 5.8.3 `POST /api/tenants/{id}/purge`

> ⚠️ **HARD DELETE — IRRÉVERSIBLE.** Cet endpoint ne peut être appelé que par
> action humaine via l'admin Hub. Le Hub refuse l'appel si le tenant n'est pas
> en `purge_eligible` (i.e. `purge_eligible_at < NOW()` ET status `soft_deleted`).

**Request** :
```json
{
  "tenant_id": "string",
  "confirm_slug": "string (doit matcher le slug du tenant, anti-erreur)",
  "reason": "string (obligatoire, audit GDPR)"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "purged_at": "ISO8601",
  "rows_deleted": {
    "emails": 12453,
    "leads": 320,
    "user_workspaces": 2,
    "...": "..."
  }
}
```

**Comportement obligatoire côté app** :
- **DELETE physique** de toute la data tenant (emails, leads, settings,
  attachments, audit logs spécifiques au tenant, etc.).
- L'`api_key` est révoquée.
- Le workspace lui-même est supprimé.
- Optionnel mais recommandé : conserver une ligne `tenants` avec
  `status='purged'`, `purged_at=NOW()`, tous les champs PII NULL, pour audit
  GDPR (preuve que la suppression a eu lieu).

**Erreur** : `409 Conflict` avec `{ error: "tenant_not_purge_eligible", purge_eligible_at }`
si le tenant n'est pas éligible.

**Garantie** : un appel `purge` réussi n'a aucun rollback. La data est perdue
en dehors d'un restore complet du backup DB (qui n'est pas une procédure
opérationnelle — c'est un dernier recours).

#### 5.8.4 `POST /api/webhooks/<app>/tenant.touched` (app → Hub)

> 🔥 **Mécanisme "revient = repousse"**. Gravé en v1.1.

**Émis par l'app** à chaque détection de **session user authentifiée** sur un
tenant en `soft_deleted` :
- Magic link consommé (user qui clique le lien d'auto-login Hub→app)
- Cookie session JWT app valide qui hit une **route protégée nécessitant
  authentification** (pas les routes publiques, pas les requêtes anonymes)

**Faux positifs à éviter** :
- ❌ Ne pas émettre pour les bots / crawlers (User-Agent suspect, pas de cookie
  session valide).
- ❌ Ne pas émettre pour les health checks internes Hub.
- ❌ Ne pas émettre plus d'une fois par tenant et par jour (l'app debounce
  localement avec un cache 24h).
- ❌ Ne pas émettre pour une session sans `tenant_id` résolvable.

**Headers** : Bearer Hub webhook token (§6.3).

**Body** :
```json
{
  "event": "tenant.touched",
  "tenant_id": "string",
  "occurred_at": "ISO8601",
  "data": {
    "user_email": "string (optionnel, audit)",
    "user_action": "magic_link_consumed|session_route_hit",
    "route_hit": "string (optionnel, ex /api/leads)"
  },
  "idempotency_key": "string (uuid v4)"
}
```

**Comportement Hub** :
- Si tenant trouvé et status = `soft_deleted` :
  - `purge_eligible_at = NOW() + TOUCH_RESET_DAYS` (cf §8.7)
  - Status reste `soft_deleted` (pas de restore auto).
  - Log audit : `lifecycle.touched`, avec contexte.
- Si tenant trouvé et status ≠ `soft_deleted` : 200 OK no-op (futur-proof,
  si l'app touche par erreur).
- Si tenant introuvable : 404.

**Response Hub** :
```json
{
  "tenant_id": "string",
  "previous_purge_eligible_at": "ISO8601|null",
  "new_purge_eligible_at": "ISO8601",
  "status": "soft_deleted (echo)"
}
```

#### 5.8.5 `GET /api/tenants/{id}/usage-summary`

> 🔥 Gravé en v1.1. Permet à l'admin Hub de **voir l'usage agrégé d'un tenant**
> avant de purger, pour décision humaine éclairée.

**Auth** : HMAC Hub (§6.1).

**Response 200** :
```json
{
  "tenant_id": "string",
  "workspace_id": "string",
  "data_volume": {
    "rows_total": 13245,
    "size_mb_estimate": 42.7
  },
  "activity": {
    "last_user_activity_at": "ISO8601|null",
    "last_machine_activity_at": "ISO8601|null",
    "active_users_30d": 1
  },
  "domain_specific": {
    "...": "champs propres à chaque app, ex pour Notifuse: emails_sent_total, emails_last_30d"
  },
  "checked_at": "ISO8601"
}
```

Chaque app remplit `domain_specific` avec ses metrics pertinentes. Le Hub
affiche dans l'admin panel pour aider à la décision purge / restore.

### 5.9 Mode dégradé paywall obfusqué

> 🔥 Pattern cross-app obligatoire gravé en v1.1. Inspiré de Prospection
> (`src/components/ui/blurred-text.tsx` + `src/components/layout/paywall.tsx`).

#### 5.9.1 Quand activer

L'app downstream doit appliquer le mode dégradé dans les **3 cas suivants** :

1. Tenant en `soft_deleted` (cf §5.7 — déclenché par Hub).
2. Trial expiré (`trial_ends_at < NOW()`) sur plan freemium.
3. Plan insuffisant pour la feature requise (ex: user free essaie d'exporter en
   masse — feature pro+).

**Pas concerné** : tenants `lifetime_*` ou `internal` — ils n'ont jamais de
mode dégradé même si Stripe webhook leur envoie n'importe quoi.

#### 5.9.2 Comportement serveur (DEFENSE EN PROFONDEUR — JAMAIS faire confiance au front)

Sur **chaque route API en lecture** qui retourne des champs sensibles, l'app
doit **obfusquer côté serveur** avant de répondre au client :

```ts
// Pattern de référence Prospection (src/app/api/leads/[domain]/route.ts:41-64)
if (degradedMode) {
  for (const field of SENSITIVE_FIELDS) {
    const val = record[field];
    if (typeof val === "string" && val.length > 0) {
      const cutoff = Math.max(1, Math.floor(val.length * 0.33));
      record[field] = val.slice(0, cutoff) + "•".repeat(val.length - cutoff);
    }
  }
}
```

**Convention** : les 33 % premiers caractères en clair, le reste remplacé par
bullets Unicode (`•`) — garde la longueur visuelle.

Sur **chaque route API en écriture**, l'app retourne `402 Payment Required` :

```json
{
  "error": "tenant_paywall",
  "reason": "soft_deleted|trial_expired|plan_insufficient",
  "upgrade_url": "https://app.veridian.site/pricing?plan=...&redirect=...",
  "support_url": "https://app.veridian.site/contact"
}
```

#### 5.9.3 Comportement UI (cosmétique en plus de la sécurité serveur)

Composant `<BlurredText>` qui pose `blur-[4px]` sur les caractères au-delà du
ratio visible. **C'est cosmétique uniquement** — la data réelle ne doit JAMAIS
arriver côté client en clair quand le mode dégradé est actif.

Composant `<Paywall>` (modale) qui s'affiche sur :
- Premier load de l'app (auto).
- Click sur une action premium (export, détail, écriture).
- Click sur un CTA "Débloquer".

**Spec de la modale** (alignement visuel cross-app) :
- Backdrop noir 60 % + blur backdrop.
- Card centrée max-width 3xl (768px).
- Header : badge rouge "X jours restants" ou "Compte désactivé".
- Body : 3 plans côte à côte (extend trial / pro / enterprise — ou équivalent
  par app).
- Footer : "Paiement sécurisé par Stripe. Annulation à tout moment."
- Bouton CTA → redirige vers Hub `/pricing?plan=<id>&redirect=<app_url>`.
- Bouton "Contacter le support" → `mailto:` ou Hub `/contact`.

#### 5.9.4 Liste des champs sensibles par app

> 🚧 À remplir par chaque agent app dans son `<app>/docs/features-by-plan.md`.

Format standard :

```markdown
# Champs sensibles (obfuscation paywall)

## Routes serveur impactées
- GET /api/<resource>/...
- POST /api/<resource>/... (écriture → 402 paywall)

## Fields à obfusquer (constant SENSITIVE_FIELDS dans le code)
- `phone`
- `email`
- `dirigeant`
- ...

## Format obfuscation
- 33% premiers caractères en clair + bullets • pour le reste
```

### 5.10 Format d'erreurs standardisé

> 🔥 Gravé en v1.1. Toute réponse d'erreur HTTP côté app **doit** respecter ce
> format. Sinon le Hub log un warning observable (§13) et peut bloquer le merge
> en CI.

```json
{
  "error": "string (code machine-readable, snake_case)",
  "message": "string (description humaine FR, pour log/debug)",
  "details": {
    "...": "champs spécifiques au code d'erreur"
  }
}
```

**Codes standard cross-app** :

| Code HTTP | `error` | Quand |
|---|---|---|
| 400 | `invalid_payload` | Body JSON invalide ou champ manquant |
| 400 | `invalid_plan` | Plan inconnu (avec `details.allowed_plans`) |
| 401 | `unauthorized` | HMAC invalide ou timestamp drift > 5min |
| 401 | `api_key_revoked` | Bearer api_key révoquée |
| 402 | `tenant_paywall` | Mode dégradé actif (cf §5.9) |
| 403 | `forbidden` | Auth OK mais pas les droits |
| 404 | `tenant_not_found` | tenant_id inexistant côté app |
| 404 | `user_not_member` | user_email pas membre du workspace |
| 409 | `tenant_conflict_owner` | provision avec owner différent |
| 409 | `api_key_multi_workspace` | api_key partagée entre workspaces |
| 409 | `idempotency_key_replay` | webhook déjà traité (idempotence) |
| 409 | `transition_illegal` | transition lifecycle non autorisée (§5.7) |
| 409 | `plan_source_immutable` | tentative downgrade plan_source=lifetime_* |
| 409 | `tenant_not_purge_eligible` | purge appelé trop tôt |
| 422 | `validation_failed` | données sémantiquement invalides (email malformé...) |
| 429 | `rate_limited` | trop de requêtes (avec `details.retry_after_ms`) |
| 500 | `internal_error` | bug app (avec `details.request_id` pour debug) |
| 502 | `upstream_error` | dépendance externe (DB, Stripe) en panne |
| 503 | `service_unavailable` | maintenance planifiée |

### 5.11 Idempotency-Key header

> 🔥 Gravé en v1.1. Protection contre les replays côté `provision`, `update-plan`,
> `soft-delete`, `restore`, `purge`.

**Header** :
```
Idempotency-Key: <uuid v4>
```

**Comportement côté app** :
- Cache la réponse pendant 24h.
- Si même clé reçue dans la fenêtre : retourne la réponse cachée (200 ou erreur,
  identique au premier appel).
- TTL 24h, après quoi la clé peut être réutilisée pour une nouvelle opération.

**Stockage côté app** :
```sql
CREATE TABLE veridian_idempotency_keys (
  key TEXT PRIMARY KEY,
  response_status INT NOT NULL,
  response_body JSONB NOT NULL,
  expires_at TIMESTAMP NOT NULL
);
CREATE INDEX ON veridian_idempotency_keys(expires_at);  -- pour cleanup cron
```

**Cleanup** : un cron supprime les entrées `expires_at < NOW()` toutes les heures.

**Comportement Hub** : génère systématiquement un UUID v4 et le passe dans le
header pour chaque appel sortant qui mute un tenant. Côté Hub, log la
correspondance `idempotency_key → tenant_id + action` pour debug.

### 5.12 Lookup user data depuis l'app downstream

> 🔥 Gravé en v1.2. Permet à une app d'afficher "Bonjour Robert" sans inventer
> son propre store user.

#### 5.12.1 Endpoint Hub `GET /api/users/{hub_user_id}`

**Auth** : HMAC Hub (l'app appelle le Hub avec sa propre signature).

**Response 200** :
```json
{
  "hub_user_id": "string",
  "email": "string",
  "display_name": "string|null",
  "locale": "fr|en|... (default fr)",
  "created_at": "ISO8601"
}
```

**Response 404** : user inexistant ou purged.

#### 5.12.2 Default obligatoire si app n'appelle pas

Si l'app downstream n'a pas besoin d'afficher de données user au-delà de
l'email reçu au `provision`, **elle n'est PAS obligée** de hit cet endpoint.
Mais elle DOIT utiliser le `owner_email` du provision comme display, jamais
inventer un autre champ.

#### 5.12.3 Cache obligatoire côté app

Si l'app appelle `/api/users/<id>`, elle DOIT cacher la réponse **15 minutes
minimum** (cache local, in-memory ou DB) pour éviter de hammer le Hub à
chaque pageview.

Invalidation : webhook Hub→app `user.updated` (à implémenter v1.3 si besoin).

### 5.13 Localisation / i18n

> 🔥 Gravé en v1.2.

**Default obligatoire** : `locale = "fr"` partout sauf si explicitement
spécifié autrement.

**Provision payload** : champ `metadata.locale` optionnel. Si absent, l'app
DOIT défaulter à `"fr"`.

**Magic link** : les templates email (signin, welcome) sont en français par
défaut. Si l'app expose une UI multilingue, elle DOIT lire la locale soit
depuis le metadata provision soit depuis le Hub `/api/users/<id>` (cf §5.12).

**Standard pour les nouvelles locales** : codes ISO 639-1 (2 lettres
minuscules). Pas de `fr-FR`, juste `fr`.

### 5.14 Lookup runtime du plan tenant côté app (cache + invalidation)

> 🔥 Gravé en v1.2. Sans ce pattern, chaque agent va inventer son cache et
> on se retrouve avec 4 implémentations divergentes.

#### 5.14.1 Source de vérité = colonne locale app

L'app stocke le `plan` courant dans sa propre DB (`tenants.plan` ou
équivalent) ET le `plan_source` (cf §3.3). C'est la **seule source de vérité
lue par les routes en runtime**. Pas de call Hub à chaque request.

#### 5.14.2 Synchronisation initiale et mises à jour

- Au `provision` : Hub envoie `plan` initial → app écrit en DB.
- Au `update-plan` HMAC : Hub envoie nouveau `plan` + `plan_source` → app
  écrit en DB.
- L'app n'invente JAMAIS un changement de plan. Elle réagit uniquement aux
  appels Hub.

#### 5.14.3 Default conservateur si désync détectée

Si l'app détecte une incohérence (ex: tenant sans `plan` en DB mais avec une
`api_key` Hub valide) :
- **Default obligatoire** : traiter comme `plan='free'`, `plan_source='manual'`.
- Logger un warning observable (§13).
- Émettre webhook `tenant.desync_detected` vers Hub (le Hub peut alors
  re-pousser le bon plan via `update-plan`).

#### 5.14.4 Pattern d'enforcement runtime

```ts
// Pattern de référence cross-app pour enforcement plan
async function requireActivePlan(tenantId: string, minPlan: string) {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, planSource: true, deletedAt: true, trialEndsAt: true },
  });

  if (!tenant) return { ok: false, reason: "tenant_not_found" };
  if (tenant.deletedAt) return { ok: false, reason: "tenant_soft_deleted" };

  // Plans offerts toujours OK
  if (["lifetime_site_vitrine", "lifetime_partner", "internal"].includes(tenant.planSource)) {
    return { ok: true, plan: tenant.plan };
  }

  // Trial expiré sur free
  if (tenant.plan === "free" && tenant.trialEndsAt && tenant.trialEndsAt < new Date()) {
    return { ok: false, reason: "trial_expired" };
  }

  // Plan insuffisant
  if (planRank(tenant.plan) < planRank(minPlan)) {
    return { ok: false, reason: "plan_insufficient" };
  }

  return { ok: true, plan: tenant.plan };
}
```

`planRank()` est une fonction app-locale qui retourne un int croissant (free=0,
starter=1, pro=2, enterprise=3, lifetime_*/internal=99).

### 5.15 Rotation api_key tenant

> 🔥 Gravé en v1.2. Indispensable si une `api_key` fuite (logs, screenshot,
> dev qui commit par erreur).

#### 5.15.1 `POST /api/tenants/{id}/rotate-api-key`

**Auth** : HMAC Hub.

**Request** :
```json
{
  "reason": "leak_suspected|periodic_rotation|admin_action"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "new_api_key": "string (à stocker IMMÉDIATEMENT côté Hub, l'ancienne est révoquée à la réception du 200)",
  "rotated_at": "ISO8601"
}
```

#### 5.15.2 Comportement obligatoire

- L'app génère une nouvelle `api_key`.
- L'ancienne reste valide **5 minutes** (overlap pour permettre au Hub de
  recevoir la response et stocker le new key sans race).
- Après 5 minutes, ancienne `api_key` → 401 `api_key_revoked`.

#### 5.15.3 Default conservateur si l'app n'a pas l'endpoint

Si l'app n'expose pas encore `rotate-api-key`, **fallback** : Hub appelle
`provision` à nouveau avec le même `tenant_id` + `owner_email` → l'app peut
soit retourner la même api_key (idempotent — INSUFFISANT pour rotation) soit
implémenter une variante `?force_new_key=true` à coder ad-hoc.

**Roadmap** : rotation api_key obligatoire dans v1.3 pour toutes les apps.

### 5.16 Transfert d'ownership

> 🔥 Gravé en v1.2. Mentionné en roadmap v1, figé maintenant.

#### 5.16.1 `POST /api/tenants/{id}/transfer-owner`

**Auth** : HMAC Hub.

**Request** :
```json
{
  "new_owner_email": "string",
  "reason": "business_sale|email_change|admin_action"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "old_owner_email": "string",
  "new_owner_email": "string",
  "transferred_at": "ISO8601"
}
```

#### 5.16.2 Comportement atomique obligatoire

- Création du `new_owner_email` comme user si pas déjà existant.
- Attachement avec `role = "owner"`.
- L'ancien owner passe à `role = "admin"` (PAS retiré — additif uniquement,
  cf §5.3).
- Webhook `tenant.owner_changed` émis vers Hub (cf §7.1).
- **Atomicité obligatoire** : transaction DB côté app. Soit tout réussit, soit
  rien ne change.

#### 5.16.3 Default si endpoint absent

L'app n'a pas encore l'endpoint → Hub utilise `attach-owner` (qui ne fait que
ADD, pas TRANSFER). C'est une dégradation acceptable : le nouveau owner
existe, l'ancien aussi. À l'admin Hub de noter l'écart manuellement.

### 5.17 Quotas exposés à l'app au provisioning

> 🔥 Gravé en v1.2. Évite de hardcoder les quotas dans chaque app.

#### 5.17.1 Body provision étendu

Le Hub peut envoyer (optionnel mais recommandé) un champ `quotas` dans le
body de `provision` :

```json
{
  "tenant_id": "...",
  "owner_email": "...",
  "plan": "pro",
  "quotas": {
    "emails_per_month": 50000,
    "leads_total": 10000,
    "members_max": 5,
    "storage_mb": 1024
  }
}
```

#### 5.17.2 Default conservateur si l'app ignore

Si l'app n'utilise pas le champ `quotas` (premier port v1.1 → v1.2), elle
**doit** :
- Lire son propre fichier `<app>/config/plans.ts` qui hardcode les quotas par plan.
- Ne JAMAIS dépasser ces quotas en runtime (enforcement local).
- Logger un warning si elle reçoit un `quotas` dans le body mais n'en tient pas
  compte (`WARN: provisional quotas ignored, using local config`).

#### 5.17.3 Source de vérité finale

Quand `quotas` est envoyé par Hub, **il prime sur le hardcoded local**. Permet
à Robert de booster un client sur un plan custom sans toucher le code app.

#### 5.17.4 Update quotas après provision

Pour modifier les quotas d'un tenant existant, le Hub appelle `update-plan`
avec un nouveau champ `quotas` (extension de §5.2). L'app le merge.

### 5.18 Sync des membres tenant cross-app (Option C)

> 🔥 Gravé en v1.3 (2026-05-19). Source de vérité = Hub. Les apps gardent leurs
> rôles internes (admin/member/visibility_scope pour Prospection, etc.) mais
> reçoivent les members via webhook Hub.

#### 5.18.1 Décision archi — Option C "modèle hybride"

Le Hub stocke le **lien minimal** `user ↔ tenant` dans une nouvelle table
`hub_app.tenant_members`. Chaque app downstream stocke ses propres `members`
internes avec ses propres rôles. Hub propage les nouveaux membres aux apps
via HMAC; chaque app applique localement.

**Le Hub ne gère PAS les permissions fines.** Il sait juste "ce humain peut
entrer dans ce tenant via SSO". L'app décide ce qu'il peut faire dedans.

#### 5.18.2 Endpoint Hub `POST /api/admin/tenants/<id>/invite-member`

**Auth** : admin Hub (`requireAdmin` + Tailscale §8.6) OU le user owner du
tenant (pour self-service depuis `/dashboard/team`).

**Request** :
```json
{
  "email": "string (member to invite)",
  "role": "member|admin (default: member, applied as default in each app)"
}
```

**Comportement Hub** :
1. Vérifie le quota `members_seats` du plan actuel (cf §3.5).
   - Si dépassement → applique la politique soft warning 7j (cf §5.21).
2. Crée ou réutilise un user Hub pour cet email.
3. Crée invitation Hub (`hub_app.invitations` réutilisée) avec token magique.
4. Envoie email d'invitation au nouvel email (via Notifuse Hub).
5. À l'acceptation par l'invité (click magic link) :
   - Ajoute ligne `hub_app.tenant_members` avec `joined_at`
   - Propage **en synchrone** à chaque app downstream avec un `POST
     /api/tenants/<id>/sync-member` HMAC (cf §5.18.3).
   - Si une app retourne 5xx : retry 3× backoff, puis log warning. Hub
     reste autoritatif.

**Response 200** (invitation créée) :
```json
{
  "tenant_id": "string",
  "invited_email": "string",
  "invitation_id": "string",
  "magic_link": "string (URL acceptation, TTL 7 jours)",
  "seats_used": 3,
  "seats_total": 5,
  "seats_warning": false
}
```

**Response 402** (quota dépassé, soft warning actif) :
```json
{
  "error": "seat_quota_exceeded_soft_warning",
  "details": {
    "seats_used": 6,
    "seats_total": 5,
    "warning_started_at": "ISO8601",
    "warning_expires_at": "ISO8601 (now + 7j)",
    "upgrade_url": "https://app.veridian.site/pricing?plan=veridian-business"
  }
}
```

**Response 402** (quota dépassé, soft warning expiré) :
```json
{
  "error": "seat_quota_exceeded_hard",
  "details": {
    "seats_used": 6,
    "seats_total": 5,
    "frozen_members": ["x@y.com"],
    "upgrade_url": "https://app.veridian.site/pricing?plan=veridian-business"
  }
}
```

#### 5.18.3 Endpoint app `POST /api/tenants/<id>/sync-member`

**Auth** : HMAC Hub (§6.1).

**Request** :
```json
{
  "user_email": "string",
  "hub_user_id": "string (Hub User.id, ref stable)",
  "role": "member|admin (default role, app peut le surcharger en interne après)",
  "invited_at": "ISO8601",
  "joined_at": "ISO8601"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "user_email": "string",
  "synced": true,
  "app_user_id": "string (id user côté app, peut différer de hub_user_id)",
  "app_role": "string (rôle effectif côté app — peut être supérieur si l'app a élevé)"
}
```

**Comportement obligatoire côté app** :
1. Crée le user app local s'il n'existe pas (type=user, sans password, email
   non vérifié — c'est le magic link Hub qui vérifie).
2. Ajoute le user au workspace tenant (Prospection : `workspace_members` avec
   rôle par défaut. Notifuse : `user_workspaces` avec rôle `member`).
3. Idempotent : si user déjà membre, retourne 200 sans rien changer.
4. **Ne JAMAIS retirer** un user existant (additif). Pour retrait, voir §5.19.

#### 5.18.4 Webhook app → Hub `tenant.member_role_changed`

Quand un app admin élève/abaisse un member en interne (ex: passer un member
Prospection à admin via UI Prospection), l'app **doit** émettre ce webhook
pour notifier le Hub (audit + cohérence cross-app).

**Le Hub n'est PAS autoritatif sur les rôles internes app.** Ce webhook est
informationnel uniquement. Hub stocke dans `tenant_members.last_known_app_role`
pour visibilité admin, mais ne change rien.

**Payload** :
```json
{
  "event": "tenant.member_role_changed",
  "tenant_id": "string",
  "data": {
    "user_email": "string",
    "old_role": "string|null",
    "new_role": "string",
    "changed_by": "string (email admin app)"
  },
  "idempotency_key": "uuid v4"
}
```

### 5.19 Retrait d'un membre

#### 5.19.1 Endpoint Hub `POST /api/admin/tenants/<id>/remove-member`

**Auth** : admin Hub ou owner du tenant.

**Request** : `{"email": "string", "reason": "user_request|admin_action"}`

**Response 200** :
```json
{
  "tenant_id": "string",
  "removed_email": "string",
  "removed_at": "ISO8601",
  "seats_used": 4,
  "seats_total": 5
}
```

**Comportement Hub** :
1. Soft delete `tenant_members.deleted_at = NOW()`.
2. Propage à chaque app via `POST /api/tenants/<id>/remove-member` HMAC.
3. Libère un seat pour le quota.

**Garde-fou** : impossible de retirer le owner. 409 `cannot_remove_owner`.
Pour transférer l'ownership, utiliser §5.16 (transfer-owner).

#### 5.19.2 Endpoint app `POST /api/tenants/<id>/remove-member`

**Comportement obligatoire** : soft delete localement (le user reste en DB
pour audit + restauration éventuelle), bloque ses accès en lecture/écriture
côté app. Sa data (leads créés, emails envoyés) reste attachée au tenant.

### 5.20 Restauration d'un membre

Si l'admin Hub a retiré un membre par erreur :

**Endpoint Hub** `POST /api/admin/tenants/<id>/restore-member { email }`

**Comportement** : annule le soft delete `tenant_members.deleted_at = NULL`,
propage à chaque app via webhook `tenant.member_restored`, chaque app annule
son soft delete local.

### 5.21 Seat overage — Soft warning 7 jours

> 🔥 Politique gravée en v1.3 par Robert : ni refus dur, ni overage automatique.
> Soft warning donne au user 7j pour décider (upgrade ou retirer un membre).

#### 5.21.1 Détection

À chaque invitation acceptée (passage `invited_at` → `joined_at`), Hub
recalcule `seats_used = count(tenant_members WHERE deleted_at IS NULL)`.

Si `seats_used > seats_total` (plan dépassé) :
- Hub crée/update `hub_app.seat_warnings { tenant_id, started_at, expires_at = started_at + 7j }`.
- Hub envoie email au owner : "⚠️ Tu as dépassé ton quota de seats. Tu as 7
  jours pour upgrader ou retirer un membre."
- L'invitation passe (ce N+1 membre est actif normalement pendant 7j).

#### 5.21.2 Comportement pendant les 7j

- Tous les members existants restent actifs (rétro-actif gentil).
- Toute **nouvelle** invitation pendant la fenêtre → 402 `seat_quota_exceeded_soft_warning`
  (l'invité supplémentaire est bloqué tant que la situation n'est pas réglée).
- Hub envoie rappel email à J+3, J+6.

#### 5.21.3 À J+7 si pas résolu

- Hub envoie email final : "❌ Quota dépassé. Les N derniers membres invités
  passent en lecture seule jusqu'à upgrade."
- Hub propage à chaque app via webhook `tenant.member_frozen { user_emails: [...] }`.
- Apps mettent ces users en mode dégradé paywall obfusqué (§5.9) côté lecture,
  402 sur écriture.
- L'owner upgrade → Hub envoie `tenant.member_unfrozen` → apps lèvent le gel.

#### 5.21.4 Default conservateur si l'app n'implémente pas le freeze

Si l'app n'a pas câblé le freeze de membres : log warning Hub, mais le
flag soft warning Hub reste actif. Le quota côté Hub bloque les nouvelles
invitations, c'est suffisant comme protection minimale.

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

### 6.5 Convention env vars staging/prod

> 🔥 Gravé en v1.1 suite au bug staging Hub↔Notifuse découvert le 2026-05-18
> (`NOTIFUSE_HUB_API_SECRET` factice côté Hub vs vrai secret côté Notifuse).
>
> ⚠️ Dette restante au 2026-05-19 : le secret `NOTIFUSE_HUB_API_SECRET_STAGING`
> n'est PAS dans les GitHub Secrets du repo `veridian-hub`. Quand la CI
> staging redéploie, elle écrit le `.env` staging avec le fallback compose
> `staging-secret` au lieu du vrai secret HMAC. Effet : appel HMAC Hub→Notifuse
> staging cassé (le hub `/api/tenants/start` retourne `Invalid signature` 401
> de Notifuse). À fixer en ajoutant le secret dans GitHub Settings → Secrets
> and variables → Actions → Repository secrets. Tracker dans
> `veridian-infra/todo/TODO-LIVE.md`.

**Côté Hub** :

| Env var | Prod | Staging |
|---|---|---|
| HMAC secret app | `<APP>_HUB_API_SECRET` | `<APP>_HUB_API_SECRET_STAGING` |
| Webhook token app | `<APP>_WEBHOOK_TOKEN` | `<APP>_WEBHOOK_TOKEN_STAGING` |
| Hub webhook token (envoi vers app) | `HUB_WEBHOOK_TOKEN_<APP>` | `HUB_WEBHOOK_TOKEN_<APP>_STAGING` |
| App URL | `<APP>_API_URL` | `<APP>_API_URL_STAGING` (ou via `${NOTIFUSE_API_URL:-default}` dans compose) |
| Admin secret Hub | `ADMIN_SECRET` | `ADMIN_SECRET` (idem var, valeur staging-only différente) |

Le compose Hub référence ces vars via `${VAR_STAGING:-default}` selon
l'environnement. Cf `compose/base.yml` + `compose/staging.yml` + `compose/prod.yml`.

**Côté app downstream** :

| Env var | Convention |
|---|---|
| HMAC secret (vient du Hub) | `HUB_API_SECRET` (identique prod/staging — c'est le `.env` qui change) |
| Hub webhook token (envoi vers Hub) | `HUB_WEBHOOK_TOKEN` |
| Hub URL | `HUB_API_URL` (ex `https://app.veridian.site` ou `https://hub.staging.veridian.site`) |

**Garde-fou obligatoire** : au boot, chaque app doit logger (sans le secret en
clair) les 8 premiers caractères du `HUB_API_SECRET` + l'environnement détecté
(`NODE_ENV` ou équivalent). Permet de débugger les désynchronisations en lisant
les logs côté Hub + côté app et comparant les empreintes.

**Rotation** : tous les 6 mois, coordonnée par l'agent Hub. Procédure de
bascule :
1. Génère un nouveau secret.
2. Stocke côté app dans `HUB_API_SECRET_NEXT` (pas `HUB_API_SECRET` encore).
3. App accepte les 2 secrets pendant 24h (compare avec les 2 en parallèle).
4. Hub passe au nouveau secret.
5. Après 24h, app supprime `HUB_API_SECRET_NEXT`, renomme `HUB_API_SECRET`.

### 6.6 Mode dev local (SKIP_HMAC)

> 🔥 Gravé en v1.1. Permet aux agents de coder en local sans monter un
> faux Hub HMAC.

Chaque app downstream **doit** supporter une env var `SKIP_HMAC=true` qui :

1. **N'est JAMAIS lue en production ou staging.** Une garde au boot vérifie :
   ```
   if SKIP_HMAC=true && NODE_ENV != "test" && NODE_ENV != "development":
     panic("SKIP_HMAC interdit en " + NODE_ENV)
   ```
2. Quand active : accepte n'importe quel header HMAC (ou aucun) et log un
   warning explicite à chaque request `WARN: HMAC bypass via SKIP_HMAC, NEVER in prod`.
3. Documenté dans le README de l'app (`Local development` section).

**Justification** : permet à un agent qui code en local de tester ses endpoints
contrat sans monter un mini-Hub. Le dev local doit rester rapide.

**Le contrat exige aussi** : tests unitaires en CI tournent **avec** HMAC vérifié
(SKIP_HMAC=false). Les tests E2E en CI peuvent utiliser SKIP_HMAC ou un Hub
mock — au choix de l'app, du moment que le test couvre le scénario contrat
(§12).

---

## 6bis. Autologin SSO-stack Veridian (3 couches)

> 🔥 Section ajoutée 2026-05-20 après brainstorm. **Scope** : ce SSO est
> **maison, interne à la stack Veridian** (Hub + apps downstream). Ce n'est
> **pas** du SSO entreprise au sens SAML/OIDC formel — voir
> `todo/2026-05-20-sso-entreprise-on-demand.md` (P5 on-demand pour quand
> un prospect en aura besoin).
>
> Le but ici est d'éviter au user de retaper email/password ou de cliquer
> sur un magic-link mail à chaque app qu'il visite dans la stack, tout en
> gardant une **résilience totale** si Hub tombe.

### 6bis.1 Vue d'ensemble — 3 couches dégradées

L'utilisateur arrive sur une app downstream (`<app>.app.veridian.site`).
L'app tente l'authentification dans cet ordre, premier succès gagne :

1. **Couche 1 — Hub broker (cas normal)**
   User clique "Open <app>" depuis Hub → Hub appelle
   `POST <app>.app.veridian.site/api/tenants/provision` (ou
   `/api/auth/issue-token`) en HMAC § 6.1 → l'app génère son **propre**
   token autologin local (cookie session app), redirige l'user vers
   `/auth/token?t=<token>` qui set le cookie et home la session.

2. **Couche 2 — Cookie cross-subdomain Hub (cas user direct)**
   User tape l'URL app direct dans son navigateur (bookmark, lien externe)
   → arrive sur `/login` app → la page check si un cookie
   `__Secure-authjs.session-token` est présent sur le domaine
   `.veridian.site` (visible depuis tous les subdomains) → si oui, l'app
   appelle `GET app.veridian.site/api/sso/whoami` server-side en forwardant
   le cookie → Hub valide la session et retourne
   `{user_id, email, exp, signature}` signé HMAC → l'app match `user_id`
   contre un workspace local et set sa propre session locale → redirect
   home. Pas de mail, pas de password, pas de friction.

3. **Couche 3 — Magic-link mail app (fallback Hub down OU pas de cookie)**
   Si couches 1 + 2 échouent (Hub HS, cookie absent, user inconnu) :
   l'user tape son email sur `/login` app → l'app génère un
   `magic_link_token` local (table `<app>_magic_links`, TTL 15 min) →
   envoie un mail via son propre canal SMTP (Brevo, Sendgrid, peu
   importe — **pas de dépendance Notifuse pour ne pas créer une chaîne
   de dépendance**) → click → cookie session app local → home. **Zéro
   dépendance Hub.** Résilience absolue.

### 6bis.2 Couche 2 — détails techniques

#### Cookie cross-subdomain côté Hub

Auth.js v5 par défaut set le cookie sur le domaine exact
(`app.veridian.site`). Il faut **explicitement** le forcer sur
`.veridian.site` (notez le `.` initial) :

```ts
// auth.ts Hub
cookies: {
  sessionToken: {
    name: '__Secure-authjs.session-token',
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      domain: '.veridian.site',  // ← critique
    },
  },
},
```

**Sécurité** : tous les subdomains `*.veridian.site` peuvent **lire** ce
cookie. Conséquences :

- Le cookie **doit rester `HttpOnly`** (lecture serveur via header Cookie
  uniquement, jamais via JS) pour qu'une XSS sur app A ne puisse pas
  l'exfiltrer.
- **Aucun subdomain user-content** (genre `user-uploads.veridian.site`
  où un user peut héberger du JS arbitraire) toléré. C'est un invariant
  d'archi.

#### Endpoint Hub `GET /api/sso/whoami`

- **Auth** : session Hub valide via le cookie cross-subdomain.
- **Réponse 200** :
  ```json
  {
    "user_id": "uuid-bridge",
    "email": "alice@bigcorp.com",
    "exp": 1234567890,
    "signature": "<hex hmac_sha256(per_app_secret, '${user_id}.${email}.${exp}')>"
  }
  ```
- **Réponse 401** si pas de session ou session expirée.
- **Signature HMAC par app** : chaque app a un secret distinct
  (`<APP>_HUB_API_SECRET` cf §6.5). Une compromission d'app A ne permet
  pas à app A de forger un whoami valide pour app B.
- **Côté app** : middleware `/login` Next.js qui call whoami server-side,
  valide la signature, match user_id contre un workspace local, crée la
  session locale, redirect.

#### Garde-fous

- **Anti-fixation** : `exp` court (~120s). Le user ne peut pas réutiliser
  une réponse whoami volée 1h après.
- **TimingSafeEqual** : la validation HMAC côté app doit utiliser
  `crypto.timingSafeEqual` (cf §6.1).
- **Pas d'auto-création** : si `user_id` ne matche aucun workspace local
  côté app, on **ne crée pas** un workspace en silence — on tombe en
  couche 3. La création de workspace passe par le flow Hub explicite
  (signup + provision §5.1).

### 6bis.3 Couche 3 — détails techniques

Chaque app maintient localement :

- Table `<app>_magic_links` : `(token, email, expires_at, used_at)`.
- Endpoint `POST /api/login/magic-link` qui prend `{email}`, génère token,
  envoie mail SMTP, log audit. **Rate limit** par IP + email (5 / 15 min).
- Endpoint `GET /auth/token?t=<token>` qui valide token, marque
  `used_at`, set cookie session app, redirect.

**Indépendance Hub** : aucun appel à Hub dans ce flow. L'app utilise sa
propre identité connue (workspaces déjà provisionnés). Si Hub est HS
pendant 1h, l'utilisateur connu de l'app peut toujours se logger.

**Mot de passe optionnel** : un user peut depuis "Settings → Security"
de l'app set un password local (bcrypt, table `<app>_passwords`). Le flow
devient : tente couche 1 → 2 → 3 → password en bypass total. Cette
feature est P3, non bloquante.

### 6bis.4 Mapping rôle / workspace

Au login (couches 1 et 2), l'app reçoit `{user_id, email}` du Hub.
L'app cherche en local :

- Membership existante via `user_id` → use cette workspace + rôle.
- Sinon, fallback sur le mapping email-domain → workspace par défaut
  (utile pour les enterprise futurs, sinon le user est isolé).
- Sinon, l'app **refuse** le login auto et tombe en couche 3.

Pas de création silencieuse de workspace. Le provisioning reste Hub-driven.

### 6bis.5 Diagramme de séquence (couche 2)

```
User browser              prospection.app.v.site       app.veridian.site
(cookie .v.site set)
       │                          │                            │
       │ GET / direct             │                            │
       ├─────────────────────────►│                            │
       │                          │ check cookie hub.session   │
       │                          │ → présent                  │
       │                          │                            │
       │                          │ GET /api/sso/whoami        │
       │                          │ (forward cookie)           │
       │                          ├───────────────────────────►│
       │                          │                            │ valide session
       │                          │                            │ retourne user_id
       │                          │ {user_id, email, sig}      │
       │                          │◄───────────────────────────┤
       │                          │ valide sig HMAC            │
       │                          │ match workspace local      │
       │                          │ set cookie prospection.    │
       │                          │ session locale             │
       │ 302 → /                  │                            │
       │◄─────────────────────────┤                            │
```

### 6bis.6 État au 2026-05-20

| Couche | État Hub | État Prospection | État Notifuse | État Analytics | État CMS |
|---|---|---|---|---|---|
| 1 broker HMAC | ✅ | 🟠 cassé (valide contre Supabase au lieu de HMAC, ticket P1 ouvert) | ✅ | n/a | n/a |
| 2 cookie cross-sub | ❌ pas câblé | ❌ | ❌ | ❌ | ❌ |
| 3 magic-link app | n/a | ⚠️ partiel | ✅ | n/a | n/a |

**Couche 1** : à fixer côté Prospection (ticket déposé), puis
opérationnelle. Notifuse déjà OK.

**Couche 2** : pas encore livrée nulle part. Roadmap :
1. Hub pose le cookie cross-subdomain `.veridian.site` (1 commit
   `auth.ts`).
2. Hub expose `GET /api/sso/whoami` (~30 lignes + tests).
3. Chaque app cable son middleware `/login` (~30 lignes par app +
   tests).
4. Coordination cross-agent via tickets `todo/`.

**Couche 3** : à généraliser. Notifuse OK natif. Prospection a la dette
de retirer Supabase (cf cleanup global). Autres apps : pas applicable
tant que pas d'app self-serve self-login (Analytics et CMS sont
client_only via shadow cards aujourd'hui).

---

## 7. Webhooks app → Hub

Endpoint Hub : `POST https://app.veridian.site/api/webhooks/<app_name>`

`<app_name>` ∈ `notifuse`, `prospection`, `analytics`, `cms`, ...

### 7.1 Événements obligatoires

| Event | Quand | Payload `data` |
|---|---|---|
| `tenant.suspended` | App suspend localement (quota, admin) | `{suspended_at, reason}` |
| `tenant.resumed` | App resume localement | `{resumed_at}` |
| `tenant.soft_deleted` | App passe en soft_deleted localement (devrait jamais arriver — Hub initiateur, mais sécurité) | `{soft_deleted_at, reason}` |
| `tenant.touched` | User authentifié actif sur un tenant soft_deleted (cf §5.8.4) | `{user_email, user_action, route_hit}` |
| `tenant.purged` | App a purgé sa data localement après ordre Hub | `{purged_at, rows_deleted}` |
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

### 7.4 Stripe → Hub → apps (chaîne billing complète)

> 🔥 Gravé en v1.2. Le contrat précédent parlait des webhooks app→Hub mais
> jamais du chemin Stripe→Hub→apps.

#### 7.4.1 Stripe webhook reçu par Hub

Hub expose `POST /api/webhooks/stripe` qui consomme :

| Event Stripe | Action Hub |
|---|---|
| `checkout.session.completed` | Mappe `stripe_price_id` → `plan` via `lib/pricing/plans.ts`. Appelle `update-plan` HMAC sur chaque app concernée par le bundle (cf §3.4 bundle Veridian). |
| `customer.subscription.updated` | Détecte si plan changé. Si oui, propage via `update-plan` sur apps concernées. |
| `customer.subscription.deleted` | Si `cancel_at_period_end=true` à l'expiration → propage `soft_delete` sur apps. Si `canceled` immédiat → idem. |
| `invoice.payment_failed` | Marque tenant `past_due` côté Hub. Pas d'action immédiate sur apps. Si 3 échecs successifs → `suspend`. |
| `invoice.payment_succeeded` | Si tenant était `suspended` pour past_due → `resume`. |
| `customer.subscription.trial_will_end` | Notif email user (CTA upgrade). Pas d'action apps. |

#### 7.4.2 Propagation Hub → apps : synchrone obligatoire

Pour chaque app concernée, le Hub appelle `update-plan` HMAC **en synchrone**
(timeout 10s par app). Pas de fire-and-forget côté Stripe webhook.

- Si une app retourne 5xx → Hub retry 3× avec backoff (1s, 2s, 4s) puis
  passe à l'app suivante mais log un erreur observable.
- Si une app retourne 4xx → Hub log erreur, ne retry pas (problème de spec).
- Stripe attend max 30s la response du Hub. Au-delà → Stripe retry son webhook
  automatiquement (idempotent côté Hub via `event.id`).

#### 7.4.3 Default conservateur en cas d'échec partiel

Si Hub a propagé sur 2 apps sur 3 et la 3e a 5xx :
- État Hub : plan mis à jour, `last_propagation_failed_app: <app_name>` en
  metadata tenant.
- L'admin lifecycle panel (§8.5) affiche un badge "Désync : `<app>` pas à jour
  depuis 2026-05-18T..." avec un bouton "Re-propage".
- Cron Hub horaire : tente de re-propager les désyncs détectées.
- Si désync > 24h : alerte Grafana (§13.4).

#### 7.4.4 Immunité plans offerts (rappel)

Si tenant a `plan_source IN ('lifetime_*', 'internal')`, Hub **ignore** les
events Stripe `subscription.deleted` ou `updated` qui voudraient downgrade.
Log warning observable. Ce comportement est gravé §3.3 mais répété ici car
c'est le point d'entrée critique de la chaîne.

---

## 8. Pilotage des plans + lifecycle depuis le Hub

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

### 8.5 Admin lifecycle panel

> 🔥 Gravé en v1.1. Page `/dashboard/admin/lifecycle` côté Hub. Restriction
> réseau §8.6.

#### 8.5.1 Vue agrégée

Tableau filtrable par status :
- `active` (default hidden)
- `suspended` (combien, depuis quand)
- `soft_deleted` (countdown affiché — vert si > 30j restants, orange 7-30j, rouge < 7j)
- `purge_eligible` (badge rouge "À PURGER OU RESTORE")
- `purged` (archive, lecture seule)

Colonnes par ligne :
- Email user owner
- Status + badge couleur
- Plan actuel (par app)
- `soft_deleted_at` si applicable
- `purge_eligible_at` countdown
- `last_touched_at` (le plus récent `tenant.touched` reçu, ou `last_user_activity_at` de l'usage-summary)
- Volume data agrégé (somme cross-app via `usage-summary`)
- Actions disponibles : `Suspend` / `Resume` / `Soft delete` / `Restore` / `Purge` / `View detail`

#### 8.5.2 Vue détail tenant

Page `/dashboard/admin/lifecycle/<tenant_id>` :
- Tous les champs du tenant Hub.
- Historique plan (cf §5.2 audit history).
- Historique lifecycle (transitions, qui les a déclenchées, quand).
- Section "Usage par app" : fan-out vers chaque `<app>/api/tenants/<id>/usage-summary`,
  affiche les metrics domain-specific.
- Section "Webhooks reçus" : 10 derniers événements `tenant.*` de cet tenant.
- Boutons d'action avec confirmation explicite (cf §8.5.3).

#### 8.5.3 Bouton "Purge maintenant"

> ⚠️ Critique. Action irréversible.

**UX obligatoire** :
1. Click "Purger maintenant" → modale s'ouvre.
2. Modale affiche :
   - Le slug du tenant en gros.
   - Un résumé du `usage-summary` (data volume, dernière activité).
   - Un input "Pour confirmer, tape le slug exact ci-dessous".
3. Bouton "Confirmer la purge" reste **disabled** tant que l'input ne matche pas
   exactement le slug.
4. Au click confirmer → POST `/api/admin/tenants/<id>/purge` avec le slug.
5. Loader pendant la propagation cross-app (chaque app fan-out → toutes les
   réponses agrégées).
6. Affiche le résumé `rows_deleted` par app.
7. Redirige vers la liste avec le tenant disparu (status `purged`).

#### 8.5.4 Action "Soft delete"

Plus simple, mais quand même confirmation modale :
- "Cela passera le tenant en mode dégradé paywall pour 90 jours."
- "Le tenant pourra encore voir son contenu floutés et payer pour réactiver."
- Bouton "Confirmer soft delete".

#### 8.5.5 Action "Restore"

Confirmation light (1 clic suffit) :
- "Annule le soft delete, le tenant repasse en `suspended`. À toi de cliquer
  `Resume` ensuite si tu veux le réactiver complètement."

#### 8.5.6 Bouton bulk "Tenants inactifs"

Filtre : `last_touched_at < NOW() - 90j AND status = 'active' AND plan IN ('free', 'freemium')`.
Affiche les candidats au soft delete proactif. Action de masse possible (mais
chaque ligne confirme individuellement — pas de "soft-delete all" en 1 clic).

### 8.6 Restriction réseau staging via Tailscale ✅ shipé 2026-05-19

> 🔥 Gravé en v1.1, **shipé en intégralité 2026-05-19** (élargi du scope
> "/admin/*" initial à TOUT le staging).

#### 8.6.1 État final shipé

**Tout `*.staging.veridian.site` est accessible uniquement via le tailnet
Veridian.** Effet net :

- Robert + machines Tailscale → accès complet à toutes les apps staging.
- Internet public → connection refused (Traefik ne bind plus l'IP publique).
- CI GitHub Actions → rejoint le tailnet via OAuth + step
  `tailscale/github-action@v3` avant le smoke test.

Plus besoin du middleware Next.js IP filter — la restriction est faite au
niveau réseau (Traefik ne sert que sur l'interface Tailscale).

#### 8.6.2 Composants concrets en place

**A — DNS Cloudflare** : `*.staging.veridian.site → 100.92.215.42` (IP
Tailscale de `dev-server-1`). Record A, proxied=false (CF ne peut pas
relayer vers IPs privées).

**B — Traefik bind Tailscale-only** : `~/traefik-staging/docker-compose.yml`
sur dev-pub :

```yaml
ports:
  - "100.92.215.42:80:80"
  - "100.92.215.42:443:443"
```

Backup compose pré-modif : `~/traefik-staging/docker-compose.yml.bak-2026-05-19`.

**C — Tailscale ACL** : section `tagOwners` avec `tag:ci-github` (cf
`~/tmp/tailscale-acl-veridian.jsonc` pour le format). Grant pour
`tag:ci-github` → `dst: ["*"]`.

**D — Tailscale OAuth client** : généré dans Trust credentials, scope
**Auth Keys Read+Write** avec tag `tag:ci-github`. Client ID +
Secret stockés en GitHub Secrets `TS_OAUTH_CLIENT_ID` /
`TS_OAUTH_SECRET` sur 3 repos (veridian-hub, veridian-prospection,
veridian-cms).

**E — Workflows CI** : step `tailscale/github-action@v3` inséré AVANT
les curl smoke staging :

```yaml
- name: Tailscale (connect runner to tailnet for staging smoke)
  uses: tailscale/github-action@v3
  with:
    oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
    oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
    tags: tag:ci-github
    version: latest
```

Repos concernés (où les smoke steps tournent sur `ubuntu-latest`) :
- `veridian-hub/.github/workflows/hub-staging.yml`
- `veridian-prospection/.github/workflows/prospection-deploy-staging.yml`
- `veridian-cms/.github/workflows/cms-staging.yml`

**Notifuse skip** car son `deploy-staging` job tourne sur self-hosted
runner (= dev-pub lui-même = déjà sur tailnet).

**F — SSH port 22 reste public** : le `Deploy stack` step de chaque CI
SSH dans dev-pub via le port 22 public (clés autorisées dans
`/home/staging-deploy/.ssh/authorized_keys`). Non concerné par Tailscale.

#### 8.6.3 Piège connu — Tailscale Serve

Avant la mise en place, **un `tailscale serve` actif sur dev-pub
interceptait le port 443 Tailscale** et empêchait Traefik d'y répondre.
Symptôme : `TLS alert internal error` (TLS 80) sur tout SNI inconnu.

Diagnostic : `sudo tailscale serve status` sur dev-pub doit retourner
"No serve config". Si autre chose, fix avec :

```bash
sudo tailscale serve reset
```

ou bouger Tailscale Serve sur un autre port (`--https=8443`).

#### 8.6.4 Tests à conserver

- ✅ Test CI : Hub staging CI (run 26101569107, 2026-05-19) — step
  Tailscale + smoke = vert. Preuve end-to-end.
- ✅ Test manuel depuis device Tailscale : `curl
  https://hub.staging.veridian.site/api/health` = 200.
- ✅ Test manuel depuis device hors Tailscale (ou avec
  `--resolve hub.staging.veridian.site:443:37.187.199.185`) : connection
  refused (000).

#### 8.6.5 Restauration en cas de problème

Si on doit rebasculer staging public (urgence) :

1. **DNS** : `curl PATCH cloudflare dns_record content=37.187.199.185`.
2. **Traefik** : `cp ~/traefik-staging/docker-compose.yml.bak-2026-05-19
   ~/traefik-staging/docker-compose.yml && cd ~/traefik-staging && sudo
   docker compose down && sudo docker compose up -d`.
3. **CI** : `git revert <commit Tailscale step>` sur les 3 repos.

Backup intégral utilisable.

### 8.7 Config lifecycle ENV Hub

> 🔥 Gravé en v1.1. Variables globales pour v1.1, path d'évolution vers
> per-plan/per-tenant.

Côté Hub `.env` :

| Variable | Default | Rôle |
|---|---|---|
| `SOFT_DELETE_GRACE_DAYS` | `90` | Délai initial entre `soft_delete` et `purge_eligible` |
| `TOUCH_RESET_DAYS` | `90` | Délai ajouté à `purge_eligible_at` à chaque `tenant.touched` qualifié |
| `TOUCH_DEBOUNCE_HOURS` | `24` | Min entre 2 touches comptabilisées pour un même tenant |
| `HARD_DELETE_MIN_GRACE_DAYS` | `30` | Refuse une purge si `soft_deleted_at > NOW() - 30j` (sécurité même pour Robert) |
| `LIFECYCLE_AUDIT_RETENTION_DAYS` | `365` | Durée de conservation des logs lifecycle pour audit GDPR |

**Évolution v2 (roadmap)** :
- Map `PLAN_LIFECYCLE_OVERRIDES` qui permet d'avoir des durées différentes
  par plan (`lifetime_*` → 365j de grâce).
- Endpoint `POST /api/admin/tenants/<id>/lifecycle { graceDays, touchResetDays }`
  pour override par tenant.
- Path d'évolution lié à l'analyse "coût compute par tenant".

### 8.8 Migration des tenants existants vers v1.x

> 🔥 Gravé en v1.2. Quand une app passe d'un état pré-contrat à v1.2, qu'est-ce
> qu'elle fait des tenants déjà en DB ?

#### 8.8.1 Au déploiement v1.x d'une app downstream

L'app DOIT exécuter un script de migration **idempotent** qui :

1. Backfill `plan_source = 'manual'` pour tous les tenants existants sans
   `plan_source` (default conservateur — pas Stripe car on ne sait pas).
2. Backfill `quotas` depuis le plan local hardcodé (cf §5.17.2).
3. Backfill `deleted_at = NULL`, `purge_eligible_at = NULL` (pas de tenant
   en soft-delete à l'origine).
4. Émet un webhook `tenant.migrated_to_v1` vers Hub pour chaque tenant
   backfilled, avec le diff.

Le Hub stocke ces diffs dans `hub_app.tenant_migration_log` pour audit.

#### 8.8.2 Du côté Hub

Quand une app downstream remonte sa version contrat dans son endpoint `health`
(ajout obligatoire : `contract_version: "1.2"`), Hub vérifie les tenants
qu'il connaît pour cette app et :
- Compare son état Hub (`tenants.<app>Plan`) avec ce que l'app rapporte.
- Si désync : appelle `update-plan` sur l'app pour réaligner.
- Log le résultat dans `hub_app.tenant_migration_log`.

#### 8.8.3 Default si l'app skip la migration

Si une app déploie v1.2 sans script de migration : tous ses tenants existants
auront `plan_source = NULL` côté DB locale. Hub détecte ça via le diff
`tenants.plan_source` reçu en webhook → Hub appelle `update-plan` avec
`plan_source = 'manual'` pour normaliser.

**Conclusion** : la migration manquante est rattrapée automatiquement, mais
c'est de la dette explicite à corriger sous 1 semaine après déploiement.

### 8.9 Affichage shadow marketing pour les apps client_only

> 🔥 Gravé en v1.3 (2026-05-19). Cf §3.6 pour la décision business.

#### 8.9.1 Logique d'affichage Hub Dashboard

Dans `app/dashboard/page.tsx`, chaque card d'app a 3 états possibles :

1. **Active visible** : l'app est `self_serve: true` OU le tenant a un plan qui
   l'inclut (typiquement `lifetime_site_vitrine`). Card normale avec bouton
   "Open" ou "Commencer l'essai gratuit".

2. **Shadow grisée** : l'app est `client_only: true` ET le tenant n'a PAS de
   plan qui l'inclut. Card grisée, badge "Inclus avec un site Veridian",
   pas de bouton actif. Au click → modal explicative (§8.9.2).

3. **Cachée** : aucune (toutes les apps sont au moins en shadow pour
   discoverability marketing).

#### 8.9.2 Modal explicative (CTA shadow apps)

Quand un user click une card shadow grisée, une modale s'ouvre :

- **Titre** : "Veridian Analytics" (ou nom de l'app)
- **Body** : "Cette application est incluse avec l'achat d'un site vitrine
  Veridian. Découvre nos offres clé en main pour entrepreneurs et TPE."
- **Bouton primaire** : "Voir les sites Veridian" → ouvre
  `https://veridian.site/sites` dans un nouvel onglet (`target="_blank"
  rel="noopener"`).
- **Bouton secondaire** : "Fermer".

#### 8.9.3 Source de vérité

Le flag `client_only` / `self_serve` vient de `lib/pricing/plans.ts` (catalogue).
Une app n'est jamais hardcodée comme "shadow" — c'est dérivé du catalogue.

Si demain Robert décide qu'Analytics devient self-serve aussi, il flip le flag
dans le catalogue et la card devient automatiquement active pour tout le monde.

#### 8.9.4 Exception : owner de plan lifetime_site_vitrine

Pour un tenant avec un plan offert `lifetime_site_vitrine` (client qui a
acheté un site) :
- Les cards Analytics + CMS s'affichent **actives** (pas grisées).
- Bouton "Open Analytics" / "Open CMS" actif (même flow magic link que
  Notifuse).
- L'invité (member) de ce tenant voit aussi les cards actives.

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
| 8. `POST soft-delete` (v1.1) | ❌ | ❌ | ❌ | ❌ |
| 9. `POST restore` (v1.1) | ❌ | ❌ | ❌ | ❌ |
| 10. `POST purge` (v1.1) | ❌ | ❌ | ❌ | ❌ |
| 11. `GET usage-summary` (v1.1) | ❌ | ❌ | ❌ | ❌ |
| 12. `tenant.touched` webhook (v1.1) | ❌ | ❌ | ❌ | ❌ |

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
| Scénario provision idempotent (Cas A/B/C §5.1) | ✅ shipé 2026-05-18 (SHA 445a8ac4) | ⚠️ À vérifier | — | — |
| Scénario attach-owner | ✅ | ❌ | — | — |
| Scénario suspend/resume cycle | ⚠️ Partiel | ❌ | — | — |
| Scénario health avant/après attach | ✅ | ❌ | — | — |
| Scénario soft-delete + paywall obfuscation (v1.1) | ❌ | ❌ | ❌ | ❌ |
| Scénario touch → repousse purge_eligible (v1.1) | ❌ | ❌ | ❌ | ❌ |
| Scénario purge avec garde-fous (v1.1) | ❌ | ❌ | ❌ | ❌ |
| Scénario plan_source immunité Stripe (v1.1) | ❌ | ❌ | ❌ | ❌ |
| Format erreurs standardisé §5.10 (v1.1) | ❌ | ❌ | ❌ | ❌ |

### 10.6 Mode dégradé paywall obfusqué (v1.1)

| Item | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| Liste `SENSITIVE_FIELDS` documentée | ❌ | ✅ (code, à doc) | ❌ | ❌ |
| Obfuscation côté serveur (33% + bullets) | ❌ | ✅ | ❌ | ❌ |
| 402 sur écritures | ❌ | ⚠️ Partiel | ❌ | ❌ |
| Composant `<Paywall>` modale | ❌ | ✅ | ❌ | ❌ |
| Composant `<BlurredText>` UI | ❌ | ✅ | ❌ | ❌ |
| Activation sur `soft_deleted` | ❌ | ❌ (pas encore de soft_delete) | ❌ | ❌ |
| Activation sur `trial_expired` | ❌ | ✅ | ❌ | ❌ |

### 10.7 Observabilité §13 (v1.1)

| Item | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| Logs JSON structurés avec `tenant_id` | ⚠️ À vérifier | ⚠️ À vérifier | ❌ | ❌ |
| Endpoint `/metrics` Prometheus | ❌ | ❌ | ❌ | ❌ |
| Alertes Grafana (cf §13.4) | ❌ | ❌ | ❌ | ❌ |

### 10.8 Idempotency-Key (v1.1)

| Endpoint | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| `provision` accepte Idempotency-Key | ❌ | ❌ | ❌ | ❌ |
| `update-plan` accepte Idempotency-Key | ❌ | ❌ | ❌ | ❌ |
| `soft-delete` accepte Idempotency-Key | ❌ | ❌ | ❌ | ❌ |
| `purge` accepte Idempotency-Key | ❌ | ❌ | ❌ | ❌ |
| Stockage `veridian_idempotency_keys` | ❌ | ❌ | ❌ | ❌ |
| Cleanup cron expired | ❌ | ❌ | ❌ | ❌ |

### 10.9 Multi-membre cross-app (v1.3)

| Item | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|
| `POST /api/tenants/<id>/sync-member` | ❌ | ❌ | ❌ | ❌ |
| `POST /api/tenants/<id>/remove-member` | ❌ | ❌ | ❌ | ❌ |
| Webhook `tenant.member_role_changed` | ❌ | ❌ | ❌ | ❌ |
| Migration backfill `hub_app.tenant_members` au deploy | — | ❌ ticket déposé | — | — |
| Freeze members soft warning §5.21 | ❌ | ❌ | ❌ | ❌ |
| Mode dégradé paywall sur members frozen | ❌ | ❌ | ❌ | ❌ |

### 10.10 Shadow marketing apps (v1.3)

| Item | Hub | Notifuse | Prospection | Analytics | CMS |
|---|---|---|---|---|---|
| Flag `self_serve`/`client_only` dans catalogue | ✅ v1.3 | self_serve | self_serve | client_only | client_only |
| Card grisée + badge si client_only et pas lifetime | ❌ TODO | — | — | — | — |
| Modal CTA "Voir les sites Veridian" | ❌ TODO | — | — | — | — |
| Activation auto si tenant=lifetime_site_vitrine | ❌ TODO | — | — | — | — |

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

### 11.5 Contrôle qualité obligatoire (RÈGLE ABSOLUE)

> 🔥 Gravé en v1.1 par Robert Brunon. **Aucune modification couverte par ce
> contrat ne va en prod sans passer ces 3 contrôles.** Si un agent ship sans
> ces contrôles, c'est faute professionnelle.

#### 11.5.1 Tests CI robustes ET actionnables manuellement

Pour chaque endpoint contrat, l'app doit avoir :

1. **Test unitaire** qui mock le HMAC + valide la logique pure (idempotence,
   transitions, validation payload).
2. **Test d'intégration** qui hit l'endpoint réel avec un Hub mock ou un Hub
   staging réel.
3. **Test E2E** qui rejoue le scénario §12 complet.

Tous les tests doivent :
- Tourner en CI bloquant sur chaque PR.
- Pouvoir tourner en **local en 1 commande** (`pnpm test`, `go test`, etc.).
- Pouvoir tourner contre **staging** via une commande explicite (`pnpm test:e2e:staging`)
  pour smoke en cas de doute prod.
- Logger en clair les hypothèses qu'ils valident (pas juste "test1 passed",
  mais "Test scénario provision idempotent — appel 2× retourne created=false").

#### 11.5.2 Smoke manuel via navigateur (Chrome MCP ou équivalent)

Avant chaque mise en prod d'une modif touchant le contrat, l'agent doit :

1. **Ouvrir un navigateur** (MCP Chrome, ou un Chrome local si l'agent tourne
   sur la machine humaine).
2. **Refaire le flow user complet** : signup Hub → click "Commencer essai" →
   ouvrir l'auto-login URL → vérifier que l'app downstream s'affiche
   correctement → faire une action sensible → vérifier que le résultat est
   cohérent avec le code modifié.
3. **Si la modif touche le lifecycle** : provoquer le state qui est concerné
   (ex: soft_delete via admin → ouvrir l'app en magic link → vérifier que
   le mode dégradé s'active correctement → vérifier que le paywall apparaît).
4. **Si la modif touche le pricing/plan** : passer le tenant en plan upgrade
   → vérifier UI + features débloquées → revenir au plan free → vérifier que
   les features sont reverrouillées.

**Sortie attendue** : screenshot ou log de session du smoke + confirmation
"flow ok, pas de régression visible". À mettre en commentaire du PR ou du
commit.

#### 11.5.3 Sanction de l'ignorance

- Modif shippée sans test CI couvrant le scope → bloque le merge automatiquement
  (Nuclear mode CI Hub, cf `CI-ARCHITECTURE.md`).
- Modif shippée sans smoke navigateur → si une régression apparaît en prod,
  c'est de la responsabilité de l'agent qui a shipé.
- Modif qui touche les §5.7-§5.11 sans bumper la matrice §10 → PR refusée par
  reviewer humain.

#### 11.5.4 Exceptions admises

Travail purement docs (modif `.md` non incluse dans path-skip CI) : pas besoin
de smoke navigateur. Test CI suffit.

Hotfix critique en prod (incident actif) : smoke peut être post-deploy, mais
DOIT être fait dans les 30 minutes suivant le ship.

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

14. soft-delete(tenant_id=T1, reason=test)
    → assert HTTP 200, purge_eligible_at = now + SOFT_DELETE_GRACE_DAYS
    → health → assert status=soft_deleted

15. GET /api/<resource> [en tant qu'user alice via magic link]
    → assert SENSITIVE_FIELDS obfusqués côté serveur (33% clear + bullets)

16. POST /api/<resource> écriture [en tant qu'user]
    → assert HTTP 402 + body { error: "tenant_paywall", upgrade_url }

17. webhook tenant.touched émis par l'app (simulation magic link consumed)
    → assert Hub repousse purge_eligible_at de TOUCH_RESET_DAYS

18. webhook tenant.touched émis 2× dans la même heure
    → assert debounce — la 2e n'est pas comptabilisée

19. purge(tenant_id=T1, confirm_slug=wrong)
    → assert HTTP 400 ou 409 (slug mismatch)

20. purge(tenant_id=T1, confirm_slug=correct) ALORS QUE soft_deleted_at < 30j
    → assert HTTP 409 { error: "tenant_not_purge_eligible" }

21. [admin "force" tenant à purge_eligible en avançant l'horloge ou via fixture]
    purge(tenant_id=T1, confirm_slug=correct, reason="test cleanup")
    → assert HTTP 200, rows_deleted détaillé
    → health → 404 (tenant n'existe plus côté app)

22. restore(tenant_id=T2 différent, en soft_deleted depuis 10j)
    → assert HTTP 200, new_status=suspended
    → health → assert status=suspended (PAS active — admin doit resume manuellement)
```

**Localisation suggérée du test** :
- Notifuse : `tests/integration/hub_contract_test.go`
- Prospection : `__tests__/integration/hub-contract.test.ts`
- Analytics / CMS / futurs : équivalent dans leur stack

**Le test doit pouvoir tourner contre l'app déployée en staging** (HUB_API_SECRET
de staging) pour permettre des E2E réels en plus des unit tests.

**Format de sortie obligatoire** : chaque étape log explicitement
`STEP N: <description> → ASSERTION: <expected> → RESULT: <actual> ✓` pour
qu'un agent qui debug puisse savoir où le scénario s'est cassé.

---

## 13. Observabilité et logs standards

> 🔥 Gravé en v1.1. Toutes les apps doivent émettre ces logs/metrics pour que
> le Hub puisse débugger les flows cross-app.

### 13.1 Logs structurés (JSON)

Chaque app downstream doit émettre des logs JSON structurés (pas du texte
libre) pour toutes les routes contrat. Format obligatoire :

```json
{
  "ts": "ISO8601",
  "level": "info|warn|error",
  "service": "<app>",
  "route": "/api/tenants/provision",
  "method": "POST",
  "tenant_id": "string (si applicable)",
  "request_id": "string (UUID v4 généré par middleware)",
  "duration_ms": 42,
  "status": 200,
  "hub_request_signature_prefix": "string (8 premiers chars HMAC signature, debug)",
  "msg": "Tenant provisioned successfully"
}
```

**Champs obligatoires** : `ts`, `level`, `service`, `route`, `tenant_id`,
`request_id`.

### 13.2 Metrics Prometheus (recommandées)

Chaque app expose `/metrics` Prometheus avec :

| Metric | Type | Labels | Description |
|---|---|---|---|
| `veridian_contract_request_duration_ms` | histogram | route, status | Latence par endpoint contrat |
| `veridian_contract_request_total` | counter | route, status, error_code | Compteur de requêtes par endpoint contrat |
| `veridian_lifecycle_tenants_total` | gauge | status | Nombre de tenants par status (active/suspended/soft_deleted/...) |
| `veridian_paywall_displayed_total` | counter | reason | Compteur d'affichages paywall par raison |
| `veridian_touch_events_emitted_total` | counter | debounced | Compteur de tenant.touched émis (et débouncés) |

### 13.3 Tracing (futur)

Roadmap v2 : propagation `traceparent` W3C entre Hub et apps pour suivre un
flow user complet (signup → provision → magic link → app session) dans Grafana
Tempo.

### 13.4 Alertes minimales obligatoires

Chaque app doit configurer ces alertes (Grafana ou équivalent) :

- Endpoint contrat down > 5min → page Robert.
- Taux d'erreur HMAC > 5 % sur 10min → page Robert (probable rotation secret
  cassée).
- Tenant.touched non émis pendant 24h alors qu'un tenant soft_deleted existe
  → warning (anomalie potentielle).
- Purge appelée → notification (jamais bloquant, mais audit).

---

## 14. Versionnement et évolution

### 14.1 Politique de versionning

- **Ajout de champs response** : OK sans bump (le Hub fait optional chaining).
- **Ajout d'endpoints obligatoires** : bump minor (v1.1, v1.2...). Délai de
  grâce 2 semaines pour compliance.
- **Breaking change endpoint existant** : bump major (v2) + endpoints `/api/v2/...`
  en parallèle pendant 1 mois. Le Hub bascule progressivement avec feature flag.
- **Suppression d'endpoint** : 3 mois de préavis + path `/api/v1/...` deprecated.

### 14.2 Process d'évolution

1. Un agent (Hub ou app) propose un changement via PR sur ce fichier
   `CONTRAT-HUB.md`.
2. Brief à Robert avec impact business + technique.
3. Validation Robert → merge sur main.
4. Tickets automatiquement déposés dans `<app>/todo/` pour chaque app impactée.
5. Suivi de compliance dans §10 de ce fichier.

### 14.3 Compatibilité backward

Aucune app downstream ne PEUT casser un comportement décrit dans une version
précédente sans :
- Bumper la version major (v2 endpoints en parallèle).
- Coordonner explicitement avec l'agent Hub.
- Donner 1 mois minimum pour la bascule.

### 14.4 Concurrent modification (optimistic locking)

> 🔥 Gravé en v1.2. Évite les race conditions quand Stripe webhook et admin
> humain arrivent en même temps sur un même tenant.

#### 14.4.1 Pattern obligatoire côté apps

Chaque app downstream qui stocke un état tenant (plan, deleted_at, etc.) DOIT
inclure une colonne `version INT NOT NULL DEFAULT 1` sur sa table tenant.

#### 14.4.2 Header `If-Match` pour les mutations

Pour les endpoints `update-plan`, `soft-delete`, `restore`, `rotate-api-key`,
`transfer-owner`, l'app DOIT accepter (et le Hub DOIT envoyer) un header :

```
If-Match: <integer version>
```

L'app vérifie : `WHERE id = ? AND version = ?`. Si match, UPDATE + `version = version + 1`.

#### 14.4.3 Conflict response

Si la version courante en DB ne matche pas le `If-Match` :

```
HTTP 412 Precondition Failed
{
  "error": "version_conflict",
  "current_version": 7,
  "supplied_version": 6
}
```

#### 14.4.4 Default conservateur si Hub ne fournit pas `If-Match`

Si Hub n'envoie pas `If-Match` (transition v1.1 → v1.2) :
- L'app applique la mutation **last-write-wins** (comportement v1.1).
- Logger un warning observable : `WARN: mutation without If-Match, race risk`.
- Émettre webhook `tenant.unversioned_mutation` vers Hub (cf §13 pour metrics).

#### 14.4.5 Hub : politique de retry sur 412

Si Hub reçoit 412 d'une app : il **relit** l'état actuel (via `health` ou
`usage-summary`), reconsidère sa décision (la mutation est-elle encore
souhaitable ?), puis retente avec le nouveau `If-Match`. Maximum 3 retries.

---

## 15. Roadmap angles morts identifiés

> 🔥 Gravé en v1.2. Ces zones sont **connues comme à traiter** mais pas
> entièrement spécifiées dans le contrat. Un agent qui les rencontre DOIT
> ouvrir un ticket `veridian-hub/todo/2026-XX-XX-<topic>.md` plutôt que
> d'inventer une solution silencieuse.

### 15.1 GDPR export user data (P1)

Un user EU peut demander l'export de toutes ses données cross-app. Hub doit
agréger.

**Spec préliminaire** :
- `GET /api/users/{hub_user_id}/gdpr-export` côté Hub.
- Hub appelle `GET /api/tenants/{id}/gdpr-export` sur chaque app downstream
  pour récupérer la data du tenant.
- Hub agrège dans un ZIP signed URL valide 24h.

**Default v1.2** : pas implémenté. Si une demande GDPR arrive, action manuelle
SQL côté chaque app. Tracker dans ticket dédié quand le premier cas arrive.

### 15.2 Rate limiting Hub → app (P2)

Le Hub peut burst sur une app downstream (ex: re-propagation massive après
incident).

**Spec préliminaire** :
- App downstream limite à **20 req/s par signature HMAC source** (= par
  HUB_API_SECRET).
- Au-delà → 429 `rate_limited` avec `Retry-After` header.
- Hub respecte un budget global de **100 req/s vers chaque app**.

**Default v1.2** : pas de rate limit côté apps. Hub ne burst pas (max 1 call
en parallèle par tenant). Acceptable tant que < 100 tenants. À implémenter
quand on passera 500 tenants ou première dégradation observable.

### 15.3 Backup et disaster recovery (P2)

Le contrat n'impose pas RPO/RTO mais recommande :

- Backup quotidien automatique de la DB de chaque app.
- Rétention 30j minimum.
- Test de restauration trimestriel.

**Default v1.2** : à charge de l'infra (`veridian-infra/`). Pas de check
automatique côté contrat. Tracker en todo infra.

### 15.4 Audit log cross-app centralisé (P2)

Chaque app a son audit log local. Le Hub a le sien. Pour faire de
l'investigation cross-app ("qu'a fait ce user partout dans Veridian le
2026-03-15 ?"), il faut agréger.

**Spec préliminaire** :
- Chaque app expose `GET /api/audit-log?tenant_id=X&from=...&to=...` (HMAC Hub).
- Hub agrège dans `/dashboard/admin/audit?user_email=X` (réservé Tailscale §8.6).

**Default v1.2** : pas implémenté. Investigation = SSH + grep dans les logs
JSON structurés (§13.1).

### 15.5 Synthetic monitoring user flow (P2)

Test automatique périodique : signup → start app → magic link → action →
logout. Pour détecter une régression avant que le user.

**Default v1.2** : pas configuré. Smoke manuel (§11.5.2) à chaque ship suffit
en early-stage. À ajouter en cron Playwright headless quand on aura > 50
tenants actifs.

### 15.6 SSO Hub → app (remplacer magic link) (P3)

Roadmap v2. Migrer de magic-link consumable (1×) vers OIDC stateless (token
JWT signé par Hub, app vérifie signature). Économise 1 round-trip.

**Default v1.2** : magic link only. Acceptable jusqu'à ~1000 sessions/jour.

### 15.7 Multi-membre par tenant côté Hub (P2)

Aujourd'hui le Hub voit 1 user owner par tenant. Mais l'app downstream peut
avoir N membres (via invites côté app, hors Hub).

**Spec préliminaire** :
- Hub expose `POST /api/admin/tenants/{id}/invite-member { email, role }`.
- Hub appelle `attach-owner` sur l'app avec le role demandé.
- L'app envoie un magic link au nouvel email.

**Default v1.2** : l'app gère ses propres invites internes. Hub ne les voit
pas. Acceptable tant que les apps font confiance à leur propre vue membres.

### 15.8 Hub down — comportement apps (P3)

Si Hub crash :
- Apps continuent de servir les requêtes user (magic link consumed, sessions
  valides via JWT signé app-locale).
- Webhooks app→Hub stockés en queue locale avec retry exponentiel.
- Si Hub > 1h down : alerte Grafana côté infra.

**Default v1.2** : pattern décrit ici. Pas de dead letter queue formelle —
chaque app retry indéfiniment avec backoff plafond 1h.

---

## 16. Changements

### v1.3 — 2026-05-19

Suite brainstorm Robert sur SSO multi-membre cross-app et apps client_only.

**Décisions business gravées** :

- §3.5 Multi-membre = feature payante. Free=1 seat solo, Pro=5 seats,
  Business=25 seats. Cross-app (1 membre voit toutes les apps souscrites).
- §3.6 Apps `self_serve` (Notifuse, Prospection) vs `client_only` (Analytics,
  CMS — réservées aux clients sites vitrines via lifetime_site_vitrine).

**Archi Option C — modèle hybride multi-membre** :

- §5.18 `POST /api/admin/tenants/<id>/invite-member` côté Hub : check quota
  seats, crée invitation Hub avec magic link, propage HMAC à chaque app via
  `POST /api/tenants/<id>/sync-member`.
- §5.18.3 `POST /api/tenants/<id>/sync-member` côté apps : crée user local +
  ajoute au workspace avec rôle par défaut. Idempotent. Additif uniquement.
- §5.18.4 Webhook `tenant.member_role_changed` app→Hub : informationnel pour
  audit cross-app, Hub NON-autoritatif sur les rôles internes app.
- §5.19 `POST /api/admin/tenants/<id>/remove-member` + propagation `POST
  /api/tenants/<id>/remove-member` aux apps (soft delete local).
- §5.20 `POST /api/admin/tenants/<id>/restore-member` pour annuler retrait
  par erreur.
- §5.21 Seat overage : politique soft warning 7j (pas refus dur, pas overage
  facturable). Email J+0, J+3, J+6. À J+7 si non résolu : freeze des
  derniers invités en lecture seule via webhook `tenant.member_frozen` /
  `tenant.member_unfrozen` après upgrade.

**Refonte Hub Dashboard** :

- §8.9 Logique 3 états : Active visible / Shadow grisée / (Cachée non utilisé).
- §8.9.2 Modal explicative au click shadow → CTA "Voir les sites Veridian"
  vers `https://veridian.site/sites`.
- §8.9.4 Exception : tenants `lifetime_site_vitrine` voient Analytics + CMS
  comme des apps actives normales.

**Migration des données existantes** :

- §10.9 Prospection backfille `hub_app.tenant_members` depuis ses
  `workspace_members` au prochain deploy v1.3 (migration douce). Notifuse
  pareil pour `user_workspaces`.

**Inchangé depuis v1.2** : §1-§2, §3.1-§3.4, §4, §5.1-§5.17, §6, §7,
§8.1-§8.8, §9, §11-§15.

### v1.2 — 2026-05-18 (soir)

**Comble les 15 angles morts identifiés par audit "agent qui débarque frais"** :

- §5.12 Lookup user data (`GET /api/users/<id>` côté Hub + cache obligatoire app).
- §5.13 Localisation : default `fr`, champ `metadata.locale` au provision.
- §5.14 Lookup runtime du plan + pattern enforcement + désync recovery.
- §5.15 Rotation api_key (`rotate-api-key` avec overlap 5min).
- §5.16 Transfer ownership atomique (`transfer-owner`).
- §5.17 Quotas exposés au provision (override hardcoded local).
- §7.4 **Stripe → Hub → apps** chaîne billing complète (le trou béant de v1.1) :
  mapping events Stripe, propagation synchrone, retry 3×, immunité plans
  offerts, recovery désync.
- §8.8 Migration tenants existants : script idempotent obligatoire au déploiement
  v1.x, rattrapage automatique côté Hub si app skip.
- §14.4 **Concurrent modification** : optimistic locking via header `If-Match`
  + version int. Évite race conditions Stripe webhook vs admin humain.
- §15 **Roadmap angles morts identifiés** : 8 sujets connus comme à traiter
  (GDPR export, rate limit, DR, audit cross-app, synthetic monitoring, SSO
  OIDC, multi-membre, Hub-down resilience). Defaults conservateurs documentés
  pour chaque, agents savent quand ouvrir un ticket plutôt que d'inventer.

**Règle nouvelle gravée en en-tête** :

> 🔥 Responsabilité agent : implémenter "à l'arrache parce que pas spécifié"
> = faute professionnelle. Soit ticket dans `veridian-hub/todo/`, soit
> documentation explicite de l'écart dans le PR.

**Inchangé depuis v1.1** : §1-§4, §5.1-§5.11, §6.1-§6.6, §7.1-§7.3, §8.1-§8.7,
§9-§13, §14.1-§14.3.

### v1.1 — 2026-05-18 (après-midi)

**Ajouts majeurs** (suite brainstorm avec Robert sur lifecycle + paywall) :

- §5.7 **Cycle de vie tenant** : machine à états explicite avec transitions
  légales (table). Aucune purge auto, "revient = repousse" via touch.
- §5.8 **5 endpoints lifecycle** : soft-delete, restore, purge, webhook
  tenant.touched, usage-summary. Remplace le `DELETE /api/tenants/{id}` ambigu
  de v1.
- §5.9 **Mode dégradé paywall obfusqué cross-app** : pattern Prospection
  généralisé. Obfuscation côté serveur, paywall modale standard, plans offerts
  immune.
- §5.10 **Format d'erreurs standardisé** : table de 20 codes machine-readable
  cross-app.
- §5.11 **Header `Idempotency-Key`** : spec figée pour provision, update-plan,
  soft-delete, restore, purge.
- §6.5 **Convention env vars staging/prod** : suite au bug
  `NOTIFUSE_HUB_API_SECRET_STAGING` désynchro découvert le 2026-05-18.
- §6.6 **Mode dev local `SKIP_HMAC`** : permet dev local rapide sans monter
  un faux Hub HMAC. Garde au boot interdit en prod/staging.
- §8.5 **Admin lifecycle panel** : page `/dashboard/admin/lifecycle` côté Hub
  avec vue agrégée, vue détail, action "Purger maintenant" avec confirm slug.
- §8.6 **Restriction réseau admin (Tailscale)** : middleware IP filter sur
  `/admin/*` et `/api/admin/*`, double protection avec Auth.js admin.
- §8.7 **Config lifecycle ENV Hub** : variables `SOFT_DELETE_GRACE_DAYS`,
  `TOUCH_RESET_DAYS`, `TOUCH_DEBOUNCE_HOURS`, etc. avec defaults
  conservateurs. Path d'évolution vers per-plan/per-tenant.
- §11.5 **Contrôle qualité obligatoire (RÈGLE ABSOLUE)** : tests CI robustes
  + smoke navigateur obligatoire avant prod sur toute modif touchant le
  contrat. Posé par Robert.
- §12 **Tests scénario étendus** : ajout 9 étapes (14-22) couvrant
  soft-delete, paywall obfuscation, touch, purge avec garde-fous.
- §13 **Observabilité et logs standards** : logs JSON structurés obligatoires
  + metrics Prometheus + alertes minimales.

**Révisions** :

- §7.1 webhooks app→Hub : ajout `tenant.touched`, `tenant.soft_deleted`,
  `tenant.purged` (remplace `tenant.deleted` ambigu).
- §8 renommé "Pilotage des plans + lifecycle".
- En-tête : règle absolue contrôle qualité ajoutée.

**Inchangé depuis v1** : §1-§4, §5.1-§5.6, §6.1-§6.4, §7.2-§7.3, §8.1-§8.4,
§9, §10, §11.1-§11.4, §14 (renuméroté).

### v1 — 2026-05-18 (matin)

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
