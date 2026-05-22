# CONTRAT-HUB-API-REF.md — Référence technique des endpoints cross-app

> **Compagnon de** `CONTRAT-HUB.md` v1.5. Le contrat grave la **vision** et
> les **invariants**. Ce document grave la **technique** : route, méthode,
> auth, schemas request/response, codes d'erreur, idempotence, exemples
> curl reproductibles, tests obligatoires.
>
> **Audience** : agents Claude (Hub + apps downstream), reviewers humains.
>
> **Source de vérité** : `veridian-hub/docs/CONTRAT-HUB-API-REF.md`. Symlinké
> depuis la racine polyrepo (`veridian-platform/CONTRAT-HUB-API-REF.md`).
> Toute modification d'un endpoint doit aussi être reflétée ici **et** dans
> le contrat (§5).
>
> **Version** : 1.3 (2026-05-22) — la spec **contractuelle billing**
> (frontière Stripe, payload `update-plan` v2, dunning, réconciliation
> POLL, articulation trial) est désormais gravée dans
> `CONTRAT-BILLING.md` v2.0. Cette API-REF garde la **référence
> technique des routes** billing (sections "Stripe webhook orchestrator"
> et "Billing & Pricing" ci-dessous) mais renvoie à `CONTRAT-BILLING.md`
> pour les invariants et la vision. v1.2 (2026-05-21 nuit) — ajout
> sections Hub-locaux (Stripe webhooks, Admin API, Workspace, Invitations
> Hub-side, Trial/cron), **Flows E2E** bout en bout, **Matrice de statut**.
>
> 🔥 **Convention** : ce document ne fait JAMAIS référence à une
> implémentation app spécifique dans le schema canonique. Il décrit le
> contrat **comme une lib externe**. Les pièges app-spécifiques (ex.
> Prospection a N workspaces par tenant, Notifuse n=1) sont dans la
> section "Notes par app" de chaque endpoint.

---

## Table des matières

- [Conventions globales](#conventions-globales)
- [Auth — 3 patterns](#auth--3-patterns)
- [Endpoints provision & lifecycle](#endpoints-provision--lifecycle)
  - [PROV — POST /api/tenants/provision (§5.1)](#prov--post-apitenantsprovision-51)
  - [PLAN — POST /api/tenants/update-plan (§5.2)](#plan--post-apitenantsupdate-plan-52)
  - [OWN — POST /api/tenants/attach-owner (§5.3)](#own--post-apitenantsattach-owner-53)
  - [SUSP — POST /api/tenants/suspend (§5.4)](#susp--post-apitenantssuspend-54)
  - [RES — POST /api/tenants/resume (§5.4)](#res--post-apitenantsresume-54)
  - [HEALTH — GET /api/tenants/{id}/health (§5.5)](#health--get-apitenantsidhealth-55)
  - [MAGIC — POST /api/workspaces.generateMagicLink (§5.6)](#magic--post-apiworkspacesgeneratemagiclink-56)
  - [SOFT — POST /api/tenants/{id}/soft-delete (§5.8.1)](#soft--post-apitenantsidsoft-delete-581)
  - [REST — POST /api/tenants/{id}/restore (§5.8.2)](#rest--post-apitenantsidrestore-582)
  - [PURGE — POST /api/tenants/{id}/purge (§5.8.3)](#purge--post-apitenantsidpurge-583)
  - [TOUCH — POST /api/webhooks/<app>/tenant.touched (§5.8.4)](#touch--post-apiwebhooksapptenanttouched-584)
  - [USAGE — GET /api/tenants/{id}/usage-summary (§5.8.5)](#usage--get-apitenantsidusage-summary-585)
- [Endpoints user/tenant management](#endpoints-usertenant-management)
  - [USER — GET /api/users/{hub_user_id} côté Hub (§5.12)](#user--get-apiusershub_user_id-côté-hub-512)
  - [EMAIL — GET /api/users/by-email côté app (§5.12 discovery)](#email--get-apiusersby-email-côté-app-512-discovery)
  - [ROT — POST /api/tenants/{id}/rotate-api-key (§5.15)](#rot--post-apitenantsidrotate-api-key-515)
  - [TRANS — POST /api/tenants/{id}/transfer-owner (§5.16)](#trans--post-apitenantsidtransfer-owner-516)
- [Endpoints multi-membre](#endpoints-multi-membre)
  - [SYNC — POST /api/tenants/{id}/sync-member (§5.18.3)](#sync--post-apitenantsidsync-member-5183)
  - [RM — POST /api/tenants/{id}/remove-member (§5.19.2)](#rm--post-apitenantsidremove-member-5192)
  - [RESTM — POST /api/tenants/{id}/restore-member (§5.20)](#restm--post-apitenantsidrestore-member-520)
  - [FREEZE — POST /api/tenants/{id}/freeze-members (§5.21)](#freeze--post-apitenantsidfreeze-members-521)
  - [UNFREEZE — POST /api/tenants/{id}/unfreeze-members (§5.21)](#unfreeze--post-apitenantsidunfreeze-members-521)
- [Endpoints invitation cross-app (P1, §5.22)](#endpoints-invitation-cross-app-p1-522)
  - [INV-CREATE — POST /api/invitations/create (Hub)](#inv-create--post-apiinvitationscreate-hub)
  - [INV-VERIFY — GET /api/invitations/[token]/verify (Hub)](#inv-verify--get-apiinvitationstokenverify-hub)
  - [INV-ACCEPT — POST /api/invitations/[token]/accept (Hub)](#inv-accept--post-apiinvitationstokenaccept-hub)
  - [INV-REVOKE — POST /api/invitations/revoke/[id] (Hub)](#inv-revoke--post-apiinvitationsrevokeid-hub)
  - [ATTACH — POST /api/veridian/workspaces/[id]/attach-member (app)](#attach--post-apiveridianworkspacesidattach-member-app)
- [Webhooks app → Hub](#webhooks-app--hub)
- [Webhooks Hub → app (push)](#webhooks-hub--app-push)
- [Endpoints Hub-locaux (Hub-side surface)](#endpoints-hub-locaux-hub-side-surface)
  - [Stripe webhook orchestrator](#stripe-webhook-orchestrator)
  - [Webhooks v1.4 app → Hub (Bearer)](#webhooks-v14-app--hub-bearer)
  - [Billing & Pricing](#billing--pricing)
  - [Provisioning Hub-side (session user)](#provisioning-hub-side-session-user)
  - [Admin API (HUB_ADMIN_SECRET ou session admin)](#admin-api-hub_admin_secret-ou-session-admin)
  - [Admin Notifuse (legacy)](#admin-notifuse-legacy)
  - [Workspace interne Hub (session user)](#workspace-interne-hub-session-user)
  - [Account / profil](#account--profil)
  - [Auth & MFA](#auth--mfa)
  - [Cron jobs](#cron-jobs)
  - [Service & runtime](#service--runtime)
- [Flows E2E (bout en bout)](#flows-e2e-bout-en-bout)
  - [Flow 1 — Invitation cross-app](#flow-1--invitation-cross-app)
  - [Flow 2 — Stripe upgrade (checkout → propagation downstream)](#flow-2--stripe-upgrade-checkout--propagation-downstream)
  - [Flow 3 — Trial intelligent (5 mails → 15j visible → CB)](#flow-3--trial-intelligent-5-mails--15j-visible--cb)
- [Format d'erreurs standardisé](#format-derreurs-standardisé)
- [Codes erreur cross-app](#codes-erreur-cross-app)
- [PERMS — Vérification des droits (§11bis du contrat)](#perms--vérification-des-droits-11bis-du-contrat)
- [Matrice de statut par endpoint](#matrice-de-statut-par-endpoint)

---

## Conventions globales

### Encodage

- Toutes les requêtes/réponses sont en **JSON UTF-8** (`Content-Type: application/json`).
- Les `tenant_id`, `workspace_id`, `user_id` sont des **UUID v4** sauf
  mention contraire. Pour les apps qui utilisent une PK différente
  (Notifuse `workspaces.id` = slug), la doc le précise dans "Notes par app".
- Les timestamps sont en **ISO 8601 UTC** (`2026-05-21T13:00:00.000Z`) sauf
  les timestamps HMAC qui sont en **Unix milliseconds** (`1747857600000`).

### Versionning d'API

- Pas de préfixe `/v1/` aujourd'hui (v1 implicite). Quand on bumpe v2 :
  - Routes en `/api/v2/...` en parallèle pendant 1 mois.
  - Feature flag côté Hub pour bascule progressive.
  - Champ `contract_version: "1.x"` dans toutes les réponses `health`.

### Headers communs

| Header | Présence | Rôle |
|---|---|---|
| `X-Veridian-Timestamp` | obligatoire HMAC | Unix ms, anti-replay 5min |
| `X-Veridian-Hub-Signature` | obligatoire HMAC | `hex(hmac_sha256(secret, "{ts}.{rawBody}"))` |
| `Authorization: Bearer <token>` | obligatoire patterns B/C | api_key tenant ou webhook token |
| `Idempotency-Key` | recommandé sur mutations | UUID v4 client-fourni, dédup 24h |
| `If-Match: "version-X"` | recommandé v1.2+ | Optimistic locking (§14.4) |
| `X-Request-Id` | recommandé | Trace cross-service. Si absent, l'app génère et propage. |

### Idempotence

- Tout endpoint mutation (POST/PATCH/DELETE) doit être **idempotent** sur
  la clé naturelle :
  - `provision` : `tenant_id`
  - `attach-member` : `(workspace_id, hub_user_id)`
  - `update-plan` : `tenant_id` (re-apply même plan = no-op)
- `Idempotency-Key` header optionnel pour les clients qui veulent forcer
  l'idempotence sur un retry réseau (§5.11).

### Pagination

- Pas de pagination sur les endpoints contractuels actuels. Si besoin
  futur : convention `?cursor=<opaque>&limit=<n>` + response
  `{ data: [...], next_cursor: "..." }`. Pas de offset/page-based.

### Rate limits par défaut

| Endpoint type | Limit |
|---|---|
| HMAC m2m (Hub → app) | 600/min/Hub-IP |
| Bearer api_key (Hub → app) | 60/min/api_key |
| Public (verify token) | 30/min/IP |
| Session user (Hub) | 120/min/user |

---

## Auth — 3 patterns

### Pattern A — HMAC Hub (m2m)

```
X-Veridian-Timestamp: 1747857600000
X-Veridian-Hub-Signature: 7d3a8b9c2e4f...
Content-Type: application/json
```

Calcul signature :
```
sig = hex(hmac_sha256(HUB_API_SECRET, "1747857600000.{\"foo\":\"bar\"}"))
```

Vérification (Node.js exemple) :
```typescript
import crypto from 'node:crypto';

function verifyHmac(ts: string, rawBody: string, sig: string, secret: string): boolean {
  const now = Date.now();
  if (Math.abs(now - Number(ts)) > 5 * 60 * 1000) return false; // 5min drift
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}
```

Exemple curl :
```bash
SECRET="$HUB_API_SECRET"
HOST="https://prospection.staging.veridian.site"
TS=$(date +%s%3N)
BODY='{"email":"smoke@yopmail.com","plan":"freemium"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)

curl -sSf -X POST "$HOST/api/tenants/provision" \
  -H "Content-Type: application/json" \
  -H "X-Veridian-Timestamp: $TS" \
  -H "X-Veridian-Hub-Signature: $SIG" \
  -d "$BODY"
```

### Pattern B — Bearer api_key tenant

```
Authorization: Bearer <api_key_clear>
Content-Type: application/json
```

Vérification côté app : `bcrypt.compare(api_key, workspace.api_key_hash)` OU
`sha256(api_key) == workspace.api_key_hash` selon implémentation. **JAMAIS**
stocker l'api_key en clair côté app.

Émise UNE seule fois par `provision` response. Si perdue → `rotate-api-key`.

### Pattern C — Bearer Hub webhook token (app → Hub)

```
Authorization: Bearer <HUB_WEBHOOK_TOKEN>
Content-Type: application/json
```

Token statique par app. Stocké côté Hub dans `<APP>_WEBHOOK_TOKEN`, côté
app dans `HUB_WEBHOOK_TOKEN`.

---

## Endpoints provision & lifecycle

### PROV — POST /api/tenants/provision (§5.1)

**Direction** : Hub → app.
**Auth** : HMAC (Pattern A).
**Trigger** : user click "Commencer l'essai gratuit" sur la carte app depuis Hub Dashboard.
**Idempotent sur** : `tenant_id`.

#### Request

```json
{
  "tenant_id": "string (UUID v4, généré par Hub)",
  "owner_email": "string (email humain)",
  "workspace_name": "string (display, max 32 chars)",
  "plan": "free | freemium | starter | pro | enterprise | lifetime_site_vitrine | lifetime_partner | internal",
  "plan_source": "stripe | manual | lifetime_site_vitrine | lifetime_partner | internal",
  "metadata": {
    "hub_user_id": "string (hub_app.users.id)",
    "stripe_customer_id": "string (optional)",
    "locale": "string (default 'fr', §5.13)",
    "quotas": {
      "monthly_emails": 1000,
      "max_leads": 500,
      "...": "..."
    }
  }
}
```

#### Response 200 (created OR idempotent)

```json
{
  "tenant_id": "string (echo)",
  "workspace_id": "string (id app-side, peut différer de tenant_id)",
  "owner_user_id": "string (id user owner côté app)",
  "owner_email": "string (echo)",
  "api_key": "string (UNIQUE, à stocker côté Hub, jamais re-fetchable)",
  "api_key_email": "string (email technique de l'api_key, pattern api+{tenant}@veridian.local)",
  "plan": "string (echo)",
  "created": true,
  "magic_link": "string (URL signin one-shot, TTL ~15min)",
  "auto_login_url": "string (URL self-contained, TTL ~60s)",
  "contract_version": "1.4"
}
```

Sur replay idempotent (mêmes `tenant_id` + `owner_email`) :
- `created: false`
- `api_key` : **null** (l'api_key n'est jamais re-révélée — utiliser `rotate-api-key`)
- `magic_link` et `auto_login_url` : re-générés frais

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | HMAC invalide / drift |
| `invalid_payload` | 400 | Zod fail |
| `invalid_plan` | 400 | Plan pas dans la liste supportée par l'app |
| `tenant_conflict_owner` | 409 | `tenant_id` existe avec un `owner_email` différent. JAMAIS écraser. |
| `internal_error` | 500 | Erreur DB |

#### Notes par app

- **Prospection** : crée `tenants` + `workspaces` (1 par défaut) + `workspace_members` (owner) + `users`. L'`api_key_hash` est stocké sur le **workspace** (1 api_key = 1 workspace).
- **Notifuse** : crée `workspaces` + `users` + `user_workspaces` (role=owner). Le `workspace.id` = slug stable issu de `tenant_id` ou métadata.

#### Tests obligatoires

- HMAC valide → 201 + DB rows créées + `api_key` retournée
- HMAC invalide → 401, AUCUNE row créée
- Replay même `tenant_id` + même email → 200, `created: false`, api_key=null
- Replay même `tenant_id` + email différent → 409, AUCUNE modif
- Plan invalide → 400 avec liste plans supportés
- Drift timestamp > 5min → 401

---

### PLAN — POST /api/tenants/update-plan (§5.2)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : Stripe webhook → Hub → propage.
**Idempotent** : oui (re-apply même plan = no-op).

#### Request

```json
{
  "tenant_id": "string",
  "plan": "string",
  "plan_source": "stripe | manual | lifetime_site_vitrine | lifetime_partner | internal",
  "reason": "string (optional, audit trail)"
}
```

#### Response 200

```json
{
  "tenant_id": "string (echo)",
  "plan": "string (echo)",
  "previous_plan": "string | null",
  "plan_source": "string (echo)",
  "applied_at": "ISO8601",
  "quotas_applied": {
    "monthly_emails": 5000,
    "max_leads": 5000
  }
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | HMAC invalide |
| `tenant_not_found` | 404 | tenant_id inconnu (renvoyé après HMAC OK) |
| `invalid_plan` | 400 | Plan pas supporté par l'app |
| `plan_source_immutable` | 409 | **CRITIQUE** : tenant a `plan_source IN (lifetime_*, internal)` et requête vient avec `plan_source = 'stripe'`. Stripe NE PEUT PAS downgrade un plan offert manuellement. |

#### Tests obligatoires

- Update plan stripe normal → 200, quotas appliqués
- Replay même plan → 200, `previous_plan: <plan>` (no-op)
- Update plan stripe sur tenant `lifetime_site_vitrine` → 409 `plan_source_immutable`
- Update plan manual sur tenant `lifetime_site_vitrine` → 200 (manual peut écraser)

---

### OWN — POST /api/tenants/attach-owner (§5.3)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : réparation manuelle d'un tenant qui a perdu son owner.

#### Request

```json
{
  "tenant_id": "string",
  "owner_email": "string",
  "hub_user_id": "string",
  "reason": "string (audit)"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "owner_user_id": "string (id user app)",
  "owner_email": "string (echo)",
  "previous_owner_email": "string | null",
  "attached_at": "ISO8601"
}
```

---

### SUSP — POST /api/tenants/suspend (§5.4)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : Stripe webhook `past_due` ou `canceled`.

#### Request

```json
{
  "tenant_id": "string",
  "reason": "stripe_past_due | stripe_canceled | admin_manual | seat_overage",
  "suspended_at": "ISO8601 (default: now)"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "suspended": true,
  "previous_status": "active | already_suspended",
  "suspended_at": "ISO8601"
}
```

**Effet côté app** : tenant passe en mode dégradé paywall obfusqué (§5.9).
Les écritures retournent 402. Lectures obfusquées (33% + bullets).

---

### RES — POST /api/tenants/resume (§5.4)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : Stripe webhook `resumed` ou upgrade.

#### Request

```json
{
  "tenant_id": "string",
  "reason": "stripe_resumed | admin_manual | upgrade",
  "resumed_at": "ISO8601 (default: now)"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "resumed": true,
  "previous_status": "suspended | already_active",
  "resumed_at": "ISO8601"
}
```

---

### HEALTH — GET /api/tenants/{id}/health (§5.5)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : cron Hub 1×/heure + check manuel admin.

#### Response 200

```json
{
  "tenant_id": "string",
  "status": "active | suspended | soft_deleted | purge_eligible | purged",
  "plan": "string",
  "plan_source": "string",
  "owner_email": "string",
  "members_count": 3,
  "workspaces_count": 1,
  "last_activity_at": "ISO8601 | null",
  "deleted_at": "ISO8601 | null",
  "purge_eligible_at": "ISO8601 | null",
  "contract_version": "1.4"
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `tenant_not_found` | 404 | (après HMAC OK) |
| `unauthorized` | 401 | HMAC fail |

---

### MAGIC — POST /api/workspaces.generateMagicLink (§5.6)

**Direction** : Hub → app.
**Auth** : Bearer api_key tenant (Pattern B).
**Trigger** : user click "Open <App>" depuis Hub Dashboard.

#### Request

```json
{
  "email": "string (user à logger, doit être membre du workspace)",
  "redirect_path": "string (optional, default '/')",
  "ttl_seconds": 900
}
```

#### Response 200

```json
{
  "magic_link": "string (URL signin one-shot)",
  "auto_login_url": "string (URL self-contained, TTL 60s)",
  "expires_at": "ISO8601"
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | api_key invalide ou révoquée |
| `user_not_member` | 403 | email pas membre du workspace de l'api_key |
| `workspace_suspended` | 423 | tenant suspendu, magic link désactivé |

---

### SOFT — POST /api/tenants/{id}/soft-delete (§5.8.1)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : user request (RGPD) OU admin lifecycle panel.

#### Request

```json
{
  "reason": "user_request | admin_action | inactivity_purge",
  "soft_deleted_at": "ISO8601 (default: now)"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "soft_deleted": true,
  "deleted_at": "ISO8601",
  "purge_eligible_at": "ISO8601 (= deleted_at + SOFT_DELETE_GRACE_DAYS, default 90j)",
  "data_retained": true
}
```

**Effet côté app** : tenant en mode paywall obfusqué. Data conservée pour
restore. Cron purge non déclenchée encore.

---

### REST — POST /api/tenants/{id}/restore (§5.8.2)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : user reconsidère / admin annule erreur.

#### Response 200

```json
{
  "tenant_id": "string",
  "restored": true,
  "new_status": "suspended | active (selon billing courant)",
  "restored_at": "ISO8601"
}
```

---

### PURGE — POST /api/tenants/{id}/purge (§5.8.3)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : décision manuelle Robert (jamais auto).

#### Request

```json
{
  "confirm_slug": "string (= <app>-<tenant_slug>-PURGE pour double-confirm)",
  "reason": "string (audit obligatoire)"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "purged": true,
  "purged_at": "ISO8601",
  "data_destroyed": true,
  "audit_log_id": "string"
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `purge_too_early` | 409 | `soft_deleted_at` < NOW() - `HARD_DELETE_MIN_GRACE_DAYS` (default 30j). Garde-fou même pour Robert. |
| `invalid_confirm_slug` | 400 | Slug ne matche pas. |

---

### TOUCH — POST /api/webhooks/<app>/tenant.touched (§5.8.4)

**Direction** : app → Hub.
**Auth** : Bearer webhook token (Pattern C).
**Trigger** : user actif sur tenant soft_deleted → repousse `purge_eligible_at`.

#### Request

```json
{
  "event": "tenant.touched",
  "tenant_id": "string",
  "data": {
    "touched_at": "ISO8601",
    "touched_by": "user_id | system | cron_inactivity_check"
  },
  "idempotency_key": "uuid v4"
}
```

Throttle 24h : un seul `tenant.touched` par tenant par fenêtre 24h
(débouncing côté app).

#### Response 200 (Hub)

```json
{
  "received": true,
  "previous_purge_eligible_at": "ISO8601",
  "new_purge_eligible_at": "ISO8601 (+ TOUCH_RESET_DAYS)"
}
```

---

### USAGE — GET /api/tenants/{id}/usage-summary (§5.8.5)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : Hub dashboard admin / cron.

#### Response 200

```json
{
  "tenant_id": "string",
  "period": "ISO8601 month start",
  "usage": {
    "leads_count": 423,
    "leads_quota": 500,
    "emails_sent": 1287,
    "emails_quota": 5000,
    "api_calls": 8392,
    "...app-specific..."
  },
  "last_activity_at": "ISO8601"
}
```

---

## Endpoints user/tenant management

### USER — GET /api/users/{hub_user_id} côté Hub (§5.12)

**Direction** : app → Hub.
**Auth** : Bearer webhook token (Pattern C).
**Trigger** : app cache miss sur user lookup.

#### Response 200 (Hub)

```json
{
  "hub_user_id": "string",
  "email": "string",
  "name": "string | null",
  "locale": "fr | en",
  "created_at": "ISO8601",
  "active": true
}
```

**Cache obligatoire côté app** : 5 min minimum (§5.12.3).

---

### EMAIL — GET /api/users/by-email côté app (§5.12 discovery)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : Hub discoverUserApps (vision Niveau 1, cf todo Hub).

#### Query string

```
?email=alice@example.com
```

#### Response 200

```json
{
  "found": true,
  "user_id": "string (id app local)",
  "hub_user_id": "string | null",
  "workspaces": [
    {
      "workspace_id": "string",
      "workspace_name": "string",
      "role": "owner | admin | member | viewer",
      "tenant_id": "string",
      "plan": "string",
      "magic_link_capable": true
    }
  ]
}
```

#### Response 200 (not found)

```json
{
  "found": false,
  "workspaces": []
}
```

#### Tests obligatoires

- HMAC OK + email existe → workspaces listés
- HMAC OK + email inconnu → 200 `found: false`
- HMAC fail → 401

---

### ROT — POST /api/tenants/{id}/rotate-api-key (§5.15)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : compromise détectée ou rotation périodique.

#### Request

```json
{
  "reason": "compromise | scheduled | admin_request"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "new_api_key": "string (UNIQUE, à stocker côté Hub immédiatement)",
  "api_key_email": "string",
  "old_api_key_revoked_at": "ISO8601 (NOW + 5min)",
  "overlap_window_ends_at": "ISO8601"
}
```

**Overlap 5 min** : les 2 api_keys (old + new) sont valides en même temps
pendant 5 min pour permettre la propagation côté Hub.

---

### TRANS — POST /api/tenants/{id}/transfer-owner (§5.16)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : user transfère son tenant à un autre user.

#### Request

```json
{
  "new_owner_email": "string",
  "new_owner_hub_user_id": "string",
  "previous_owner_email": "string (sanity check, refuse si ne matche pas)"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "old_owner_id": "string",
  "new_owner_id": "string",
  "transferred_at": "ISO8601"
}
```

---

## Endpoints multi-membre

### SYNC — POST /api/tenants/{id}/sync-member (§5.18.3)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : admin Hub `invite-member` (§5.18.2). Distinct du flow P1
self-service invitation (§5.22 = `attach-member`).

#### Request

```json
{
  "user_email": "string",
  "hub_user_id": "string",
  "role": "owner | admin | member",
  "invited_at": "ISO8601",
  "joined_at": "ISO8601"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "user_email": "string",
  "synced": true,
  "app_user_id": "string (id local)",
  "app_role": "string (rôle effectif local, JAMAIS écrasé si existant)",
  "added_to_workspace_id": "string (workspace par défaut du tenant)"
}
```

**Différence avec `attach-member` (§5.22)** : `sync-member` ajoute au
workspace **par défaut** du tenant (création si absent). `attach-member`
ajoute à un workspace **précis**. Pour Notifuse (1 workspace = 1 tenant)
les 2 endpoints sont équivalents.

---

### RM — POST /api/tenants/{id}/remove-member (§5.19.2)

**Direction** : Hub → app.
**Auth** : HMAC.

#### Request

```json
{
  "user_email": "string",
  "hub_user_id": "string",
  "reason": "user_request | admin_action | freeze_expired"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "user_email": "string",
  "removed": true,
  "removed_at": "ISO8601",
  "soft_deleted_workspace_members": 2
}
```

Soft delete sur **toutes** les `workspace_members` lignes du user pour ce tenant.
Refuser le owner → 409 `cannot_remove_owner`.

---

### RESTM — POST /api/tenants/{id}/restore-member (§5.20)

**Direction** : Hub → app.
**Auth** : HMAC.

#### Request

```json
{
  "user_email": "string",
  "hub_user_id": "string"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "restored": true,
  "restored_workspace_members": 2
}
```

Annule le soft delete sur toutes les rows.

---

### FREEZE — POST /api/tenants/{id}/freeze-members (§5.21)

**Direction** : Hub → app.
**Auth** : HMAC.
**Trigger** : seat overage J+7 sans résolution.

#### Request

```json
{
  "user_emails": ["alice@x", "bob@y"],
  "reason": "seat_overage_j7"
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "frozen": ["alice@x", "bob@y"],
  "frozen_at": "ISO8601"
}
```

**Effet côté app** : ces users passent en mode paywall obfusqué côté
lecture (§5.9), 402 sur écriture. Data conservée.

---

### UNFREEZE — POST /api/tenants/{id}/unfreeze-members (§5.21)

**Direction** : Hub → app.
**Auth** : HMAC.

#### Request

```json
{
  "user_emails": ["alice@x", "bob@y"]
}
```

#### Response 200

```json
{
  "tenant_id": "string",
  "unfrozen": ["alice@x", "bob@y"]
}
```

---

## Endpoints invitation cross-app (P1, §5.22)

### INV-CREATE — POST /api/invitations/create (Hub)

**Direction** : app **ou** user → Hub.
**Auth** : HMAC m2m (Pattern A) si app, **OU** session user Hub si user-side.

#### Request (app HMAC)

```json
{
  "inviter_user_id": "string (hub_user_id de l'inviter)",
  "inviter_email": "string",
  "invitee_email": "string",
  "target_app": "notifuse | prospection | analytics | cms",
  "target_workspace_id": "string",
  "target_role": "owner | admin | member | viewer",
  "message": "string (optional, max 500 chars)"
}
```

#### Response 201

```json
{
  "invitation_id": "string (hub_app.cross_app_invitations.id)",
  "token": "string (32 bytes hex)",
  "magic_link_url": "https://app.veridian.site/invite/<token>",
  "expires_at": "ISO8601 (created + 7j)",
  "email_dispatched": true
}
```

**Idempotence** : si une invitation pending existe déjà pour
`(invitee_email, target_app, target_workspace_id)` → 200 avec
l'invitation existante (pas de re-création, pas de re-email).

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | HMAC ou session invalide |
| `forbidden` | 403 | session user qui n'est pas owner/admin du target_workspace_id |
| `target_workspace_not_found` | 404 | workspace inconnu (vérifié côté app via API) |
| `invitee_already_member` | 409 | l'invitee est déjà membre du workspace |
| `rate_limited` | 429 | 60/min/IP |

---

### INV-VERIFY — GET /api/invitations/[token]/verify (Hub)

**Direction** : public (UI `/invite/[token]`).
**Auth** : aucune.

#### Response 200 (valid)

```json
{
  "valid": true,
  "state": "valid",
  "invitee_email": "string",
  "target_app": "string",
  "target_workspace_id": "string",
  "target_workspace_name": "string (display, lookup côté app)",
  "target_role": "string",
  "inviter_email": "string",
  "inviter_name": "string | null",
  "expires_at": "ISO8601"
}
```

#### Response 200 (états non-valid, anti-leak)

```json
{
  "valid": false,
  "state": "expired | already_accepted | not_found | revoked"
}
```

**Anti-leak** : sur états non-valid, JAMAIS révéler `invitee_email`,
`inviter_email`, `target_workspace_id`. Évite l'énumération de tokens.

---

### INV-ACCEPT — POST /api/invitations/[token]/accept (Hub)

**Direction** : user (depuis UI `/invite/[token]`).
**Auth** : session user Hub (cookie Auth.js).

#### Response 202 (étape 4a actuelle — phase 4b en attente apps)

```json
{
  "accepted": true,
  "invitation_id": "string",
  "target_app": "string",
  "target_workspace_id": "string",
  "downstream_call": "pending",
  "redirect_url": "https://<app>.app.veridian.site (fallback bas-niveau)"
}
```

#### Response 200 (étape 4b finalisée — quand `attach-member` côté app livré)

```json
{
  "accepted": true,
  "invitation_id": "string",
  "target_app": "string",
  "target_workspace_id": "string",
  "downstream_call": "completed",
  "downstream_member_id": "string (id local côté app)",
  "redirect_url": "string (login_url retourné par attach-member, TTL 60s)"
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | session manquante |
| `email_mismatch` | 409 | session user.email !== invitee_email (avec warning UI option override) |
| `token_invalid` | 410 | expired / revoked / not_found / already_accepted |

---

### INV-REVOKE — POST /api/invitations/revoke/[id] (Hub)

**Direction** : inviter (session).
**Auth** : session user Hub. Forbidden-prioritaire (vérifié AVANT not_found
pour éviter l'enum).

#### Response 200

```json
{
  "revoked": true,
  "invitation_id": "string",
  "revoked_at": "ISO8601"
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `forbidden` | 403 | session user n'est pas l'inviter |
| `already_accepted` | 409 | trop tard pour revoke |
| `not_found` | 404 | (seulement APRÈS forbidden check) |

---

### ATTACH — POST /api/veridian/workspaces/[id]/attach-member (app)

**Direction** : Hub → app.
**Auth** : HMAC (Pattern A).
**Trigger** : Hub `invitations/accept` (phase 4b).
**Idempotent sur** : `(workspace_id, hub_user_id)`.

#### Request

```json
{
  "hub_user_id": "string",
  "hub_user_email": "string",
  "role": "owner | admin | member | viewer",
  "invitation_id": "string (audit)"
}
```

#### Response 201 (création)

```json
{
  "attached": true,
  "already_member": false,
  "member_id": "string (id row workspace_members côté app)",
  "workspace_id": "string (echo)",
  "role": "string (echo)",
  "login_url": "string (auto-login TTL 60s, OU null si non implémentable)"
}
```

#### Response 200 (idempotent)

```json
{
  "attached": true,
  "already_member": true,
  "member_id": "string",
  "workspace_id": "string",
  "role": "string (rôle LOCAL existant, JAMAIS écrasé)",
  "login_url": "string | null"
}
```

#### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | HMAC fail |
| `invalid_body` | 400 | Zod fail |
| `workspace_not_found` | 404 | workspaceId inconnu (renvoyé APRÈS HMAC OK) |
| `workspace_gone` | 410 | workspace soft_deleted |
| `workspace_suspended` | 423 | tenant suspendu pour billing |

#### Tests obligatoires

- HMAC valide → 201 + row workspace_members créée + audit log
- HMAC invalide → 401, AUCUNE row
- Replay (mêmes params) → 200 already_member=true
- Replay avec role différent → 200 already_member=true, role LOCAL préservé, log info
- Workspace inconnu après HMAC OK → 404
- Workspace soft_deleted → 410
- Tenant suspended → 423
- Drift timestamp > 5min → 401

#### Notes par app

- **Prospection** : `workspace_members(workspace_id, user_id)` PK. `visibility_scope` reste `'all'` par défaut (admin Prospection peut downgrade ensuite). `users.hub_user_id` à backfiller au premier appel.
- **Notifuse** : `user_workspaces(workspace_id, user_id)`. `workspaceId` = slug. `users.hub_user_id` à backfiller.

---

## Webhooks app → Hub

### Format payload standard

```json
{
  "event": "tenant.<event_name>",
  "tenant_id": "string",
  "data": { /* event-specific */ },
  "idempotency_key": "uuid v4",
  "occurred_at": "ISO8601",
  "contract_version": "1.4"
}
```

### Événements obligatoires

| Event | Quand | Data fields |
|---|---|---|
| `tenant.touched` | user actif sur tenant soft_deleted (throttle 24h) | `touched_at, touched_by` |
| `tenant.suspended` | tenant passe en suspended côté app (admin local) | `reason, suspended_at` |
| `tenant.resumed` | tenant repasse en active côté app | `resumed_at` |
| `tenant.soft_deleted` | soft delete confirmé côté app | `deleted_at, reason` |
| `tenant.purged` | purge confirmée côté app | `purged_at` |
| `tenant.owner_changed` | transfer-owner exécuté | `old_owner_id, new_owner_id` |
| `tenant.member_role_changed` (§5.18.4) | admin app change rôle local | `user_email, old_role, new_role, changed_by` |
| `tenant.quota_exceeded` | usage > quota du plan | `metric, used, quota` |

### Retry policy

- 3 retries avec backoff exponentiel (1s, 4s, 16s)
- Si échec définitif : log + stocker en outbox locale (table `hub_webhook_outbox`)
- Rejouer au boot ou via cron

### Sécurité

- Bearer token statique par app (`HUB_WEBHOOK_TOKEN`)
- Hub vérifie + déduplique sur `idempotency_key` (fenêtre 24h)

---

## Webhooks Hub → app (push)

Aujourd'hui Hub n'a pas de webhook formel vers les apps. Les "events"
Hub vers apps passent par les appels HTTP m2m HMAC :

- Update plan → `POST /api/tenants/update-plan`
- Suspend/resume → `POST /api/tenants/{suspend,resume}`
- Soft delete → `POST /api/tenants/{id}/soft-delete`
- Member sync → `POST /api/tenants/{id}/sync-member`
- Member attach → `POST /api/veridian/workspaces/{id}/attach-member`
- Member remove/restore → `POST /api/tenants/{id}/{remove,restore}-member`
- Freeze/unfreeze → `POST /api/tenants/{id}/{freeze,unfreeze}-members`

**Pas de format webhook générique** pour ces calls — ce sont des endpoints
contractuels distincts, chacun avec son schema dédié dans ce document.

---

## Endpoints Hub-locaux (Hub-side surface)

> Section ajoutée v1.2 (2026-05-21). Documente la **surface HTTP du Hub
> lui-même** — les ~30 routes qui vivent dans `veridian-hub/app/api/` et
> qui sont consommées soit par le front Hub (session user), soit par
> Stripe (webhook signé), soit par les apps downstream (Bearer/HMAC).
>
> Convention :
> - **Pattern auth** = "Session Hub" (cookie Auth.js), "x-admin-secret"
>   (header `HUB_ADMIN_SECRET`), "Stripe-Signature" (HMAC Stripe whsec_…),
>   "Bearer app" (token statique `<APP>_WEBHOOK_TOKEN`), "HMAC app" (Pattern A
>   du contrat, `x-veridian-invitation-signature`), "Bearer CRON_SECRET".
> - **Statut** : ✅ livré / 🟡 partiel / ⏳ en cours / 🔵 stub / ❌ non prévu.

### Stripe webhook orchestrator

> 📦 **Source de vérité contractuelle : `CONTRAT-BILLING.md` v2.0.** Cette
> section décrit la **route technique** de l'orchestrateur Stripe. Les
> invariants (frontière Stripe unidirectionnelle, payload `update-plan`
> v2, dunning, réconciliation POLL, articulation trial) sont gravés dans
> `CONTRAT-BILLING.md`. En cas de divergence, `CONTRAT-BILLING.md` fait foi.

#### STRIPE-WH — POST /api/webhooks (Stripe central)

**Statut** : ✅ livré 2026-05-21 (refactor orchestrateur, ticket
`todo/2026-05-21-stripe-webhook-orchestrator.md`).
**Direction** : Stripe → Hub.
**Auth** : signature Stripe `Stripe-Signature` (whsec_…). Le **raw body**
est validé via `stripe.webhooks.constructEvent(body, sig, webhookSecret)` —
JAMAIS parser le JSON avant. Le secret est lu via `getStripeWebhookSecret()`
(`STRIPE_WEBHOOK_SECRET` test ou `STRIPE_WEBHOOK_SECRET_LIVE` prod).
**Idempotence** : persistance dans `hub_app.stripe_events` (PK = `event.id`).
Un event déjà processé (`processedAt IS NOT NULL`) → 200 `idempotent:true`
sans re-dispatch. Stripe peut retry jusqu'à 30 min, ce garde-fou est obligatoire.

#### Events couverts

| Event Stripe | Action côté Hub | Propagation |
|---|---|---|
| `checkout.session.completed` (mode subscription) | resync DB + propagation | → Notifuse update-plan + Prospection update-plan (selon `subscription_data.metadata.plan_key`) |
| `customer.subscription.created` | resync DB + propagation | idem |
| `customer.subscription.updated` | resync DB + propagation | idem |
| `customer.subscription.deleted` | downgrade DB + propagation free | → apps revert à `free`/`freemium` |
| `customer.subscription.trial_will_end` | log only (V1) | V2 → mail "trial finit dans 3j" |
| `invoice.payment_succeeded` | audit only (V1) | V2 → dashboard MRR |
| `invoice.payment_failed` | log + alert Telegram si `attempt_count ≥ 3` | V2 = state machine dunning |
| `customer.deleted` | `softDeleteTenantsForCustomer(customer.id)` — `Tenant.deletedAt + status='deleted'` | aucune (pas de call apps : tenant déjà mort côté Stripe) |
| autres | `outcome: 'ignored'` | aucune |

#### Request

```
POST /api/webhooks
Content-Type: application/json
Stripe-Signature: t=1747857600,v1=7d3a8b9c2e4f...,v0=...
```

Body : raw bytes Stripe Event (cf [Stripe Event API](https://stripe.com/docs/api/events/object)).

#### Response 200 (succès ou idempotent)

```json
{
  "received": true,
  "outcome": "processed | ignored | already_processed | failed",
  "eventId": "evt_1NxYZk2eZvKYlo2C4..."
}
```

#### Response 400 (signature invalide)

```
Webhook Error: No signatures found matching the expected signature for payload.
```

(Plain text, pas JSON — c'est ce que Stripe attend.)

#### Curl exemple (test local)

```bash
# Replay d'un event Stripe via CLI Stripe (fixture)
stripe trigger customer.subscription.updated --forward-to http://localhost:3000/api/webhooks

# Vérifier dans DB
psql "$DATABASE_URL" -c "SELECT event_id, event_type, processed_at, error FROM hub_app.stripe_events ORDER BY received_at DESC LIMIT 5;"
```

#### Codes erreur

| Code HTTP | Sens |
|---|---|
| 200 | Event reçu + dispatché OU déjà processé (idempotent) OU ignoré |
| 400 | Signature absente / invalide / drift trop élevé |

**JAMAIS de 4xx/5xx hors signature** : on retourne 200 même sur échec de
dispatch downstream, pour éviter le retry Stripe inutile. Les échecs sont
tracés dans `stripe_events.error` + alerte Telegram. Le cron de retry
(P2 à câbler) consommera la liste `processed_at IS NULL`.

#### Tests existants

- `__tests__/lib/stripe/dispatcher.test.ts` (idempotence + dispatch par event_type)
- `e2e/staging-full/09-stripe-webhook-dispatcher.spec.ts`
- `__tests__/api/webhooks/route.test.ts` (signature, idempotence)

#### Notes

- Le `subscription_data.metadata.plan_key` est posé côté `/api/billing/checkout`
  (cf [BILLING-CHECKOUT](#billing--checkout--post-apibillingcheckout)). C'est la
  **source de vérité PlanKey** côté Hub. Le webhook le relit pour propager
  aux apps downstream avec `plan_source='stripe'`.
- Si propagation HMAC vers Notifuse échoue (3 retries internes au
  `NotifuseClient` exhaustés) → alerte Telegram à Robert. L'event est
  marqué `error` dans `stripe_events` mais on retourne 200.

---

### Webhooks v1.4 app → Hub (Bearer)

#### WH-NOTIFUSE-V14 — POST /api/webhooks/notifuse

**Statut** : ✅ livré 2026-05-21 (refactor route — coexiste avec legacy HMAC).
**Direction** : Notifuse → Hub.
**Auth** : si header `Authorization: Bearer <NOTIFUSE_WEBHOOK_TOKEN>` présent
→ **dispatch v1.4** (table `webhook_dedup`). Sinon fallback **legacy HMAC**
(headers `x-veridian-timestamp` + `x-veridian-notifuse-signature`, secret
`NOTIFUSE_HUB_WEBHOOK_SECRET`).
**Dédup v1.4** : PK `webhook_dedup(app='notifuse', idempotency_key)` — fenêtre 24h.

##### Request v1.4

```
POST /api/webhooks/notifuse
Authorization: Bearer notif_whk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

```json
{
  "event": "tenant.touched",
  "tenant_id": "8f3a7b9c-2e4f-4a1b-9c8e-1234567890ab",
  "data": {
    "touched_at": "2026-05-21T14:23:00.000Z",
    "touched_by": "user_id:abc123"
  },
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
  "occurred_at": "2026-05-21T14:23:00.123Z",
  "contract_version": "1.4"
}
```

##### Response 200

```json
{ "ok": true }
```

##### Response 200 (dédup)

```json
{ "ok": true, "deduplicated": true }
```

##### Events v1.4 actuellement câblés (handlers réels)

| Event | Action côté Hub |
|---|---|
| `tenant.touched` | 🔵 stub (persiste dans `webhook_dedup.payload` + log info — sera branché sur reset `purge_eligible_at` quand §5.18 sera implé Hub-side) |
| `tenant.member_role_changed` | 🔵 stub (sera branché sur `tenant_members.last_known_app_role` §5.18.4) |
| `tenant.activity_threshold_reached` | 🔵 stub (signal anti-churn / déclencheur trial state machine, cf ticket `2026-05-21-trial-state-machine.md`) |

Tout event non listé = persisté + 200 (stub permissif pour permettre aux
apps d'émettre dès aujourd'hui sans bloquer le Hub).

##### Events legacy HMAC (héritage fork Notifuse — à retirer en v1.5)

| Event legacy | Action côté Hub |
|---|---|
| `tenant.provisioned` | log only |
| `tenant.suspended` | update `metadata.notifuse_suspended_at` |
| `tenant.resumed` | clear `metadata.notifuse_suspended_*` |
| `tenant.deleted` | update `metadata.notifuse_deleted_at` |
| `email.sent` | incr `metadata.notifuse_emails_sent_this_month` |
| `tenant.quota_exceeded` | warn log (V2 = alerte) |

##### Tests existants

- `__tests__/api/webhooks/notifuse-v14.test.ts`
- `__tests__/lib/webhooks/receiver.test.ts`
- `e2e/staging-full/08-webhooks-app-to-hub-v14.spec.ts`

---

#### WH-PROSP-V14 — POST /api/webhooks/prospection

**Statut** : ✅ livré 2026-05-21 (v1.4 only — pas de legacy Prospection).
**Direction** : Prospection → Hub.
**Auth** : `Authorization: Bearer <PROSPECTION_WEBHOOK_TOKEN>`.
**Dédup** : `webhook_dedup(app='prospection', idempotency_key)`.

##### Request

Identique au schema v1.4 ci-dessus (event + tenant_id + data + idempotency_key
+ occurred_at + contract_version).

##### Events couverts

| Event | Action |
|---|---|
| `tenant.touched` | 🔵 stub |
| `tenant.member_role_changed` | 🔵 stub |
| `tenant.activity_threshold_reached` | 🔵 stub (sera consommé par trial state machine) |
| `tenant.suspended` | 🔵 stub (admin Prospection peut suspendre localement) |
| `tenant.resumed` | 🔵 stub |

##### Tests existants

- `e2e/staging-full/08-webhooks-app-to-hub-v14.spec.ts`

---

#### WH-TENANT-ACTIVITY — POST /api/webhooks/tenant-activity (Trial state machine)

**Statut** : 🟡 partiel — webhook `tenant.activity_threshold_reached` reçu
via le handler standard de `/api/webhooks/notifuse` (WH-NOTIFUSE-V14). Le
**cron tick** dédié `/api/cron/trial-tick` (cf [CRON-TRIAL](#cron-trial--post-apicrontrial-tick))
consomme ensuite `hub_app.tenant_trials` pour faire avancer la machine.
Pas d'endpoint séparé `/api/webhooks/tenant-activity` finalement — le handler
WH-NOTIFUSE-V14 stub doit être branché pour UPSERT `tenant_trials`.
**Direction** : Notifuse → Hub (via WH-NOTIFUSE-V14).
**Auth** : Bearer `NOTIFUSE_WEBHOOK_TOKEN`.

##### Request prévue (spec ticket)

```json
{
  "event": "tenant.activity_threshold_reached",
  "tenant_id": "8f3a7b9c-2e4f-4a1b-9c8e-1234567890ab",
  "data": {
    "metric": "emails_sent",
    "threshold": 5,
    "value": 5,
    "first_reached_at": "2026-05-22T10:00:00.000Z"
  },
  "idempotency_key": "uuid-v4",
  "occurred_at": "2026-05-22T10:00:00.000Z",
  "contract_version": "1.4"
}
```

##### Action prévue

UPSERT `tenant_trials` :
- Si pas de row → INSERT `state='eligible'` + `first_signal_at`
- Si `state='eligible'` depuis ≥ 48h → cron tick passera à `state='trial_active'`
  (auto-upgrade vers pro avec `plan_source='stripe_trial'`)
- Si `state='trial_active'` → no-op (déjà en trial)

##### Notes

Tant que ce ticket n'est pas livré, l'event `tenant.activity_threshold_reached`
est absorbé par le handler stub de `/api/webhooks/notifuse` (log seulement,
pas d'effet de bord côté trial state machine).

---

### Billing & Pricing

> 📦 **Source de vérité contractuelle : `CONTRAT-BILLING.md` v2.0.** Les
> routes ci-dessous sont la **référence technique** ; le contrat billing
> (frontière Stripe, `update-plan` v2, trial, réconciliation) prime pour
> les invariants.

#### BILLING-CHECKOUT — POST /api/billing/checkout

**Statut** : ✅ livré (sprint v1.0). Couvre upgrade Stripe.
**Direction** : front Hub → Hub.
**Auth** : Session Hub (`requireUser`).

##### Request

```json
{
  "plan": "veridian_pro_monthly",
  "interval": "month",
  "redirect": "/dashboard/billing?checkout=success"
}
```

##### Response 200

```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_a1...",
  "session_id": "cs_test_a1B2C3..."
}
```

Le front fait `window.location = data.url`.

##### Codes erreur

| Code | Status | Sens |
|---|---|---|
| `user_no_email` | 400 | session sans email (impossible normalement) |
| `invalid_json` | 400 | body non parseable |
| `invalid_payload` | 400 | Zod fail |
| `unknown_plan` | 400 | `plan` pas dans `lib/pricing/plans.ts` |
| `plan_not_payable` | 400 | plan a `plan_source !== 'stripe'` (lifetime_*, internal) |
| `plan_is_free` | 400 | `price_eur === 0` — provisionner via `/api/tenants/start` |
| `stripe_price_not_configured` | 503 | placeholder pas rempli côté env |
| `stripe_customer_failed` | 502 | `resolveStripeCustomerId` a échoué |
| `stripe_session_failed` | 502 | `stripe.checkout.sessions.create` rejected |

##### Curl exemple

```bash
curl -X POST https://app.veridian.site/api/billing/checkout \
  -H "Content-Type: application/json" \
  -H "Cookie: __Secure-authjs.session-token=eyJhbGc..." \
  -d '{"plan":"veridian_pro_monthly","interval":"month"}'
```

##### Tests existants

- `__tests__/api/billing/checkout.test.ts`
- `__tests__/api/billing/billing.test.ts`
- `__tests__/api/billing/billing-validation.test.ts`

---

#### PRICING-PLANS — GET /api/pricing/plans

**Statut** : ✅ livré (sprint v1.0).
**Direction** : public.
**Auth** : aucune.
**Cache** : `Cache-Control: public, max-age=3600, s-maxage=3600,
stale-while-revalidate=86400`. ISR 1h côté Next.

##### Response 200

```json
{
  "plans": [ /* PLANS du submodule @veridian/shared */ ],
  "refill": {
    "pricing_cents": [...],
    "max_per_order": 1000
  },
  "annual_perks": [...],
  "version": "0.1.0",
  "generated_at": "2026-05-21T14:00:00.000Z"
}
```

##### Consommation type

Notifuse Go appelle au boot avec TTL local 1h, fallback sur valeurs par
défaut si Hub down (générosité = pas de risque).

##### Tests existants

- `__tests__/api/pricing/plans.test.ts`

---

### Provisioning Hub-side (session user)

#### TENANT-START — POST /api/tenants/start

**Statut** : ✅ livré 2026-05-21 (refactor signup auto-provision → click manuel).
**Direction** : front Hub → Hub.
**Auth** : Session Hub.
**Idempotent** : si l'app est déjà provisionnée → retour `already_provisioned`
sans rappel downstream.

##### Request

```json
{ "app": "notifuse | prospection | all" }
```

Body vide → defaults `all`.

##### Response 200

```json
{
  "ok": true,
  "tenant_id": "uuid-v4",
  "app_requested": "all",
  "notifuse": {
    "success": true,
    "workspace_id": "ws_8f3a7b9c",
    "auto_login_url": "https://notifuse.app.veridian.site/auto-login?t=...",
    "error": null
  },
  "prospection": {
    "success": true,
    "tenant_id": "prosp-uuid",
    "login_url": "https://prospection.app.veridian.site/login?t=...",
    "error": null
  },
  "errors": []
}
```

##### Tests existants

- `__tests__/api/tenants/start.test.ts`
- `__tests__/utils/tenants/provision.test.ts`
- `e2e/staging-full/06-provisioning-cross-app.spec.ts`

---

#### TENANT-RETRY — POST /api/tenants/retry

**Statut** : ✅ livré.
**Direction** : front Hub → Hub.
**Auth** : Session Hub.
**Usage** : retry provisioning si `/tenants/start` a échoué partiellement.

##### Response 200

```json
{
  "message": "Provisioning completed",
  "user_id": "uuid",
  "notifuse": { "success": true },
  "prospection": { "success": true }
}
```

---

#### TENANT-STATUS — GET /api/tenants/status

**Statut** : ✅ livré.
**Direction** : front Hub → Hub.
**Auth** : Session Hub.

##### Response 200

```json
{
  "tenant_id": "uuid",
  "name": "Acme Corp",
  "status": "active | suspended | deleted",
  "notifuse": {
    "configured": true,
    "slug": "ws_8f3a7b9c"
  },
  "logs": [
    { "id": "...", "level": "info", "message": "...", "service": "notifuse", "createdAt": "..." }
  ]
}
```

---

#### NOTIFUSE-CREATE — POST /api/notifuse/create-tenant

**Statut** : ✅ livré (legacy — gardé pour scripts ops).
**Direction** : front Hub → Hub → Notifuse fork.
**Auth** : Session Hub.
**Body** : `{ workspaceId, workspaceName }`.

Tendance long terme : à réabsorber dans `/api/tenants/start` une fois
multi-tenant workspace supporté (cf §5.18).

---

#### PROSPECTION-REGEN — POST /api/prospection/regenerate-login

**Statut** : ✅ livré.
**Direction** : front Hub → Hub → Prospection.
**Auth** : Session Hub.

Re-call `provisionTenant` côté Prospection (upsert) pour obtenir un fresh
`login_url`. Persiste le token dans `Tenant.prospectionLoginToken`.

##### Response 200

```json
{
  "login_url": "https://prospection.app.veridian.site/auth/login?t=...",
  "tenant_id": "prosp-uuid"
}
```

---

### Admin API (HUB_ADMIN_SECRET ou session admin)

> **Pattern auth standardisé** depuis 2026-05-20 (cf memory
> `reference_hub_admin_api.md`) : helper `authenticateAdmin(request)` qui
> accepte soit `x-admin-secret: <HUB_ADMIN_SECRET>` (mode service), soit
> une session avec `isPlatformAdmin(user) === true`.
>
> Toute mutation écrit dans `hub_app.audit_log` via `writeAuditLog`.
> Lookup par `actor` via index dédié.

#### ADMIN-USER-CREATE — POST /api/admin/users/create

**Statut** : ✅ livré 2026-05-20.
**Idempotent** : si email existe → retour user existant + `already_existed:true`.

##### Request

```json
{
  "email": "client@acme.com",
  "name": "Didier Acme",
  "supabaseUserId": "550e8400-e29b-41d4-a716-446655440000",
  "metadata": { "source": "manual-import" }
}
```

##### Response 200

```json
{
  "user_id": "ckl3m4n5o6p7q8r9s0",
  "supabase_user_id": "550e8400-...",
  "email": "client@acme.com",
  "created": true,
  "already_existed": false
}
```

##### Audit log

`action='admin.user.create'`, `target_type='user'`,
`payload.already_existed`.

##### Curl exemple

```bash
curl -X POST https://app.veridian.site/api/admin/users/create \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: hubsec_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" \
  -d '{"email":"client@acme.com","name":"Didier Acme"}'
```

##### Tests

- `__tests__/api/admin/users/create.test.ts`
- `e2e/staging-full/07-admin-api-roundtrip.spec.ts`

---

#### ADMIN-USER-GET — GET /api/admin/users/[email]

**Statut** : ✅ livré 2026-05-20.
**Auth** : `authenticateAdmin`.

##### Response 200

```json
{
  "user": {
    "id": "ckl3...",
    "email": "client@acme.com",
    "name": "Didier",
    "email_verified": "2026-05-20T12:00:00.000Z",
    "mfa_enabled": false,
    "supabase_user_id": "550e8400-...",
    "created_at": "2026-05-19T10:00:00.000Z",
    "providers": [
      { "provider": "google", "provider_account_id": "115...", "type": "oauth" },
      { "provider": "credentials", "provider_account_id": "client@acme.com", "type": "credentials" }
    ],
    "active_sessions": 1
  },
  "tenants": [
    {
      "id": "uuid",
      "name": "Acme Corp",
      "status": "active",
      "notifuseWorkspaceSlug": "ws_acme",
      "prospectionPlan": "pro"
    }
  ]
}
```

##### Tests

- `__tests__/api/admin/users/[email].test.ts`

---

#### ADMIN-TENANT-LINK — POST /api/admin/tenants/link-app

**Statut** : ✅ livré 2026-05-20.
**Idempotent**.

##### Request

```json
{
  "user_email": "client@acme.com",
  "app": "cms | analytics | notifuse | prospection",
  "external_tenant_id": "acme-prod",
  "external_tenant_slug": "acme",
  "tenant_name": "Acme Corp",
  "plan": "pro",
  "fallback_url": "https://acme.cms.veridian.site",
  "magic_link_capable": true,
  "provisioning_source": "manual.script.v1",
  "notes": "Migration depuis legacy"
}
```

##### Response 200

```json
{
  "tenant_id": "uuid",
  "user_id": "550e8400-...",
  "app": "cms",
  "metadata_path": "cms.external_tenant_id",
  "created": false
}
```

##### Tests

- `__tests__/api/admin/tenants/link-app.test.ts`

---

#### ADMIN-TENANT-UNLINK — DELETE /api/admin/tenants/unlink-app

**Statut** : ✅ livré 2026-05-20.
**Direction** : Soft unlink — la row Tenant reste en DB pour audit.

##### Request

```json
{
  "user_email": "client@acme.com",
  "app": "cms",
  "reason": "Migration terminée"
}
```

##### Response 200

```json
{ "tenant_id": "uuid", "app": "cms", "unlinked": true }
```

---

#### ADMIN-AUDIT — GET /api/admin/audit-log

**Statut** : ✅ livré 2026-05-20.

##### Query string

```
?actor=admin:robert@veridian.site&limit=100&since=2026-05-21T00:00:00Z
```

##### Response 200

```json
{
  "actor": "admin:robert@veridian.site",
  "count": 12,
  "events": [
    {
      "id": "ckl...",
      "action": "admin.tenant.link",
      "actor": "admin:robert@veridian.site",
      "targetType": "app_link",
      "targetId": "uuid",
      "payload": { /* event-specific */ },
      "createdAt": "2026-05-21T14:00:00.000Z"
    }
  ]
}
```

##### Tests

- `__tests__/lib/admin/audit-log.test.ts`

---

#### ADMIN-LIST-TENANTS — GET /api/admin/list-tenants

**Statut** : ✅ livré.
**Direction** : Hub admin.
**Auth** : `requireAdmin` (legacy header `x-admin-secret`).

##### Response 200

```json
{
  "total": 24,
  "tenants": [
    {
      "tenant_id": "uuid",
      "user_id": "550e8400-...",
      "email": "client@acme.com",
      "name": "Acme",
      "status": "active",
      "plan": "pro",
      "services": {
        "prospection": { "provisioned": true, "plan": "pro" },
        "notifuse": { "provisioned": true, "plan": "pro", "plan_source": "stripe" }
      },
      "trial_ends_at": null,
      "created_at": "2026-05-19T10:00:00.000Z"
    }
  ]
}
```

---

#### ADMIN-DELETE-TENANT — DELETE /api/admin/delete-tenant

**Statut** : ✅ livré. Destructif.
**Effets** : soft-delete tenants liés + delete subscriptions + delete profile
+ delete auth user (cascade Account/Session/MfaCode via FK).

##### Request

```json
{ "email": "client@acme.com", "confirm": true }
```

##### Response 200

```json
{
  "ok": true,
  "email": "client@acme.com",
  "user_id": "550e8400-...",
  "actions": [
    "Soft-deleted tenant uuid",
    "⚠️ Notifuse workspace ws_acme still exists (manual cleanup needed)",
    "Deleted 1 subscription(s)",
    "Deleted auth user"
  ]
}
```

##### Notes

NE supprime PAS le workspace Notifuse côté fork — cleanup manuel via
`/api/admin/notifuse/delete`.

---

#### ADMIN-GRANT-PLAN — POST /api/admin/grant-plan

**Statut** : 🟡 partiel — **deprecated**, remplacé par `/api/admin/tenants/[id]/plan`.

Garde un fallback pour scripts ops legacy. Restreint à
`freemium | pro | enterprise`.

---

#### ADMIN-TENANT-PLAN — POST /api/admin/tenants/[id]/plan

**Statut** : ✅ livré (unifié 2026-05-18).

##### Request

```json
{
  "app": "notifuse | prospection",
  "plan": "pro",
  "trialEndsAt": "2026-06-15T00:00:00Z",
  "reason": "Compensation incident 2026-05-17"
}
```

##### Response 200

```json
{
  "ok": true,
  "tenant_id": "uuid",
  "app": "notifuse",
  "plan": "pro",
  "trial_ends_at": "2026-06-15T00:00:00.000Z",
  "set_by": "robert@veridian.site",
  "set_at": "2026-05-21T14:00:00.000Z"
}
```

Pour `app='prospection'` : pas encore de push HMAC vers Prospection
(cf ticket `todo/integrations/prospection-update-plan-2026-05-18.md`),
DB seule côté Hub avec `warning` dans la réponse.

##### Tests

- `__tests__/api/admin/tenants/[id]/plan.test.ts`

---

#### ADMIN-IMPERSONATE — POST /api/admin/impersonate

**Statut** : 🟡 partiel — endpoint Prospection/Notifuse OK, mais Hub
`/api/auth/impersonate-callback` pas encore implémenté (TODO LOT D).

##### Request

```json
{ "email": "client@acme.com" }
```

##### Response 200

```json
{
  "user_id": "550e8400-...",
  "email": "client@acme.com",
  "tenant_id": "uuid",
  "links": {
    "hub": "https://app.veridian.site/api/auth/impersonate-callback?token=...",
    "prospection": "https://prospection.app.veridian.site/auth/login?t=...",
    "notifuse": "https://notifuse.app.veridian.site"
  },
  "session": {
    "token": "32bytes-hex",
    "expires": "2026-05-22T14:00:00.000Z"
  }
}
```

---

#### ADMIN-ORPHANS — GET /api/admin/users/orphans

**Statut** : ✅ livré 2026-05-20.

##### Query string

```
?minAgeDays=7&limit=100
```

##### Response 200

```json
{
  "totalOrphans": 3,
  "scannedAt": "2026-05-21T14:00:00.000Z",
  "orphans": [
    {
      "id": "ckl...",
      "email": "abandoned@yopmail.com",
      "createdAt": "2026-05-14T...",
      "ageDays": 7
    }
  ]
}
```

Read-only. Pour delete → cron `/api/cron/cleanup-orphan-users` (dry-run only).

##### Tests

- `__tests__/lib/admin/find-orphan-users.test.ts`
- `__tests__/api/admin/users/orphans.test.ts`

---

### Admin Notifuse (legacy)

> Endpoints admin spécifiques Notifuse pré-v1.4 — appellent directement
> le fork via HMAC. À terme remplacés par les endpoints contractuels
> génériques (SUSP, RES, SOFT, PURGE, PLAN). Gardés pour rétrocompat
> tooling.

| Endpoint | Méthode | Statut | Action |
|---|---|---|---|
| `/api/admin/notifuse/status?tenantId=...` | GET | ✅ | Read-through HMAC → workspace state |
| `/api/admin/notifuse/suspend` | POST | ✅ | Suspend HMAC + écrit `metadata.notifuse_suspended_*` |
| `/api/admin/notifuse/resume` | POST | ✅ | Resume HMAC + clear marqueurs |
| `/api/admin/notifuse/delete` | DELETE | ✅ | Soft-delete HMAC (30j rétention fork) |
| `/api/admin/notifuse/update-plan` | POST | ✅ | Push plan + audit history (max 50 entrées) |
| `/api/admin/notifuse/magic-link` | POST | ✅ | Génère magic_link pour tenant owner ou admin (session user, pas admin secret) |

Body type commun : `{ tenantId: <hub_tenant_id>, reason?, plan?, planSource? }`.
`resolveNotifuseTenant(tenantId)` mappe `Tenant.id` → `notifuseWorkspaceSlug`.

##### Tests

- `__tests__/api/admin/notifuse/*` (status, suspend, resume, delete, update-plan, magic-link)
- `__tests__/lib/notifuse/admin-notifuse.test.ts`

---

### Workspace interne Hub (session user)

> ⚠️ **Modèle Invitation distinct de CrossAppInvitation** (cf memory
> `reference_hub_invitation_model_split.md`). Ce modèle gère les invitations
> à un **workspace interne du Hub** (table `Invitation`), pas les
> invitations cross-app vers Notifuse/Prospection (table `CrossAppInvitation`).

#### WS-INVITE — POST /api/workspace/invite

**Statut** : ✅ livré.
**Direction** : front Hub → Hub.
**Auth** : Session Hub. Caller doit être `OWNER` ou `ADMIN` du workspace.

##### Request

```json
{
  "workspaceId": "ckl...",
  "email": "newmember@acme.com",
  "role": "ADMIN | MEMBER | VIEWER"
}
```

##### Response 200

```json
{ "ok": true, "invitationId": "ckl..." }
```

##### Codes erreur

| Status | Sens |
|---|---|
| 401 | Non authentifié |
| 403 | Caller n'est pas OWNER/ADMIN du workspace |
| 404 | Workspace introuvable |
| 409 | Email déjà membre |
| 422 | Body invalide |

Email envoyé via Brevo (template MJML inline). En cas d'échec d'envoi
l'invitation reste créée — admin peut renvoyer le lien manuellement.

---

#### WS-ACCEPT — POST /api/workspace/invite/accept

**Statut** : ✅ livré.
**Direction** : front Hub → Hub.
**Auth** : Session Hub.

##### Request

```json
{ "token": "32bytes-hex" }
```

##### Response 200

```json
{ "ok": true }
```

##### Codes erreur

| Status | Sens |
|---|---|
| 401 | Non authentifié |
| 403 | Email session ≠ email invitation |
| 404 | Invitation introuvable |
| 409 | Déjà acceptée OU déjà membre |
| 410 | Invitation expirée |

Atomique : crée `WorkspaceMember` + marque `Invitation.acceptedAt` dans
une transaction Prisma.

---

#### WS-MEMBER-PATCH — PATCH /api/workspace/members/[id]

**Statut** : ✅ livré.
**Direction** : front Hub → Hub.
**Auth** : Session Hub. Role check via `canChangeRole(actor, target)`.

##### Request

```json
{ "role": "ADMIN | MEMBER | VIEWER" }
```

(Pas de promotion vers OWNER via cette route — utiliser `transfer-owner`
contractuel quand livré.)

---

#### WS-MEMBER-DELETE — DELETE /api/workspace/members/[id]

**Statut** : ✅ livré.

##### Response 204

(no content)

##### Codes erreur

- 403 : tentative de retrait du OWNER OU droits insuffisants
- 404 : member introuvable

##### Provisioning au signup

Depuis 2026-05-21, `/api/auth/signup` provisionne automatiquement un
workspace par défaut via `provisionDefaultWorkspace(user, opts)` (cf
`lib/workspace/provision.ts`). Best-effort — un échec ne bloque pas le
signup (backfill prod rattrape). Pattern Linear/Notion : mono-workspace
auto-créé silencieusement, l'user peut en créer d'autres ensuite.

##### Tests

- `__tests__/api/workspace/invite.test.ts`
- `__tests__/api/workspace/invite-accept.test.ts`
- `__tests__/api/workspace/members.test.ts`
- `__tests__/lib/workspace/provision.test.ts`

---

### Account / profil

| Endpoint | Méthode | Statut | Auth | Action |
|---|---|---|---|---|
| `/api/account/profile` | PATCH | ✅ | Session | Update `name`/`email` (force re-verify si email change) |
| `/api/account/password` | POST | ✅ | Session | Change/Crée password bcrypt (12 rounds) |
| `/api/account/connected-providers` | GET | ✅ | Session | Liste providers OAuth (sans tokens) |
| `/api/account/connected-providers/[provider]` | DELETE | ✅ | Session | Désassocie provider OAuth (garde-fou anti-lockout transactionnel) |
| `/api/account/recent-subscription` | GET | ✅ | Session | Dernière subscription (BigInt sérialisé) — utilisé par PurchaseTracker GA4 |

##### Garde-fou anti-lockout `/connected-providers/[provider]`

```
Refuse 409 last_login_method si suppression laisse 0 Account au user.
Transaction Prisma serialise les checks contre les races (2 onglets).
Provider 'credentials' refusé via cette route (404 unsupported_provider)
— passer par /api/account/password.
```

##### Tests

- `__tests__/api/account/profile.test.ts`
- `__tests__/api/account/password.test.ts`
- `__tests__/api/account/connected-providers.test.ts`
- `__tests__/api/account/[provider].test.ts`
- `__tests__/api/account/recent-subscription.test.ts`

---

### Auth & MFA

| Endpoint | Méthode | Statut | Auth | Action |
|---|---|---|---|---|
| `/api/auth/[...nextauth]` | * | ✅ | n/a | Handler Auth.js v5 (signin, callback, signout, etc.) |
| `/api/auth/signup` | POST | ✅ | rate-limited 5/min/IP | Crée User + Account credentials + workspace par défaut |
| `/api/auth/mfa/toggle` | POST | ✅ | Session | Active/désactive MFA email pour l'user courant |
| `/api/auth/mfa/verify` | POST | ✅ | rate-limited via lib | Vérifie code 6 chiffres, pose cookie `mfa_passed_<uid>` (5min, httpOnly) |
| `/api/auth/mfa/resend` | POST | ✅ | rate-limited 5/h/user | Nouveau code (NE leak PAS l'existence de l'user) |

##### Signup flow

```json
POST /api/auth/signup
{ "email": "client@acme.com", "password": "secretpass123" }

→ 201 { "id": "ckl...", "email": "client@acme.com" }
→ 429 { "error": "rate_limited" }   // 5/min/IP, Retry-After header
→ 409 { "error": "An account with this email already exists" }
→ 400 { "error": "Invalid email or password (min 8 chars)" }
```

Bcrypt 10 rounds. `User.supabaseUserId = randomUUID()` (pont vers
`tenants.user_id`/`subscriptions.user_id`).

##### MFA verify flow

```json
POST /api/auth/mfa/verify
{ "userId": "ckl...", "code": "123456" }

→ 200 { "ok": true }  + Set-Cookie: mfa_passed_<uid>=1
→ 401 { "ok": false, "error": "invalid_code" }
```

Le cookie est lu par `signIn` callback (`auth.ts`) pour laisser passer
sans re-envoi de code. TTL 5 min.

##### Tests

- `__tests__/api/auth/signup.test.ts`
- `__tests__/lib/mfa.test.ts`
- `__tests__/lib/mfa-template.test.ts`
- `__tests__/api/auth/mfa-toggle.test.ts`
- `__tests__/api/auth/mfa-verify.test.ts`
- `__tests__/api/auth/mfa-resend.test.ts`
- `__tests__/lib/auth/rate-limit.test.ts`

---

### Cron jobs

| Endpoint | Méthode | Statut | Auth | Schedule |
|---|---|---|---|---|
| `/api/cron/cleanup-orphan-users` | POST | ✅ (dry-run) | Bearer `CRON_SECRET` | Hebdomadaire |
| `/api/cron/cleanup-trials` | POST | 🟡 partiel | Bearer `CRON_SECRET` | Quotidien |
| `/api/cron/cleanup-trials` | GET | ✅ | public (status only) | n/a |
| `/api/cron/trial-tick` | POST | ✅ | Bearer `CRON_SECRET` | Toutes les 30 min (`hub-trial-tick-cron.yml`) |

##### CRON-TRIAL — POST /api/cron/trial-tick

**Statut** : ✅ livré 2026-05-21 (ticket `2026-05-21-trial-state-machine.md`).

État machine sur `hub_app.tenant_trials` :

1. `state='eligible'` depuis ≥48h
   → `state='trial_active'`, `trial_started_at=NOW()`, `trial_ends_at=NOW()+15d`
   → `notifuseClient.updatePlan(plan='pro')` HMAC
   → email "trial démarré" + alerte Telegram Robert
2. `state='trial_active'` depuis ≥12j ET `ending_soon_notified=false`
   → `ending_soon_notified=true` + email "expire dans 3j"
3. `state='trial_active'` ET `trial_ends_at ≤ NOW()`
   - Si Stripe sub active → `state='converted'` (pas de downgrade)
   - Sinon → `state='expired'`, `expired_at=NOW()` +
     `updatePlan(plan='free')` + email "trial terminé" + Telegram

##### Race conditions

Transaction PG `SELECT ... FOR UPDATE SKIP LOCKED` par tranche : 2e cron
sur même fenêtre skip les rows verrouillées (reprises au tick suivant).

##### Idempotence

Si crash entre UPDATE state et call downstream → state inchangé, retry
naturel au tick suivant. Calls downstream (`updatePlan`) idempotents
côté Notifuse, plusieurs appels successifs safe.

##### Response 200

```json
{
  "ok": true,
  "summary": {
    "activated": 3,
    "notified": 12,
    "expired": 1,
    "converted": 2,
    "errors": []
  },
  "duration_ms": 1843
}
```

##### Tests existants

- `__tests__/api/cron/trial-tick.test.ts`
- `__tests__/lib/trial/transitions.test.ts`

##### CRON-ORPHANS — POST /api/cron/cleanup-orphan-users

⚠️ **DÉLIBÉRÉMENT PASSIF** : `mode='dry-run'`, ne supprime rien. Log liste
des orphelins pour revue manuelle. RGPD policy à figer avant activation
mode delete (P2).

```json
{
  "mode": "dry-run",
  "durationMs": 423,
  "totalOrphans": 3,
  "minAgeDays": 7,
  "scannedAt": "2026-05-21T03:00:00.000Z",
  "orphans": [{ "id": "ckl...", "ageDays": 7 }]
}
```

##### CRON-TRIALS — POST /api/cron/cleanup-trials

Supprime workspaces Notifuse expirés (trial > 15j sans CB). Sera élargi
P1 par le ticket trial-state-machine pour gérer le flow complet.

##### Tests

- `__tests__/api/cron/cleanup-orphan-users.test.ts`
- `__tests__/api/cron/cleanup-trials.test.ts`
- `__tests__/lib/admin/find-orphan-users.test.ts`

---

### Service & runtime

| Endpoint | Méthode | Statut | Auth | Sens |
|---|---|---|---|---|
| `/api/health` | GET | ✅ | public | Healthcheck Docker + smoke CI/CD |
| `/api/config` | GET | ✅ | public | Variables runtime publiques (NEXT_PUBLIC_*, ENV mappées DASHBOARD_*) |

##### HEALTH-HUB — GET /api/health

```json
{ "status": "ok", "timestamp": "2026-05-21T14:00:00.000Z", "service": "web-dashboard" }
```

200 obligatoire (gate Docker healthcheck + smoke CI). Cache 5min côté
ALB / Cloudflare.

##### CONFIG — GET /api/config

```json
{
  "NEXT_PUBLIC_SITE_URL": "https://app.veridian.site",
  "NEXT_PUBLIC_NOTIFUSE_URL": "https://notifuse.app.veridian.site",
  "NEXT_PUBLIC_NOTIFUSE_API_URL": "https://notifuse-api.veridian.site",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_test_...",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE": "pk_live_...",
  "NEXT_PUBLIC_GTM_ID": "GTM-XXXXXX"
}
```

⚠️ `dynamic = 'force-dynamic'` OBLIGATOIRE — sans ça Next fige les valeurs
build-time = null en runtime.

##### Tests

- `__tests__/api/health.test.ts`
- `__tests__/api/config.test.ts`
- `__tests__/lib/oauth-health-check.test.ts`

---

## Flows E2E (bout en bout)

> Trois scénarios complets qui exercent la chaîne front → Hub → apps
> downstream, pour servir de référence d'implémentation aux agents.

### Flow 1 — Invitation cross-app

**Acteurs** : Inviter (admin/owner Notifuse), Invitee (peut être un user
inexistant côté Hub).

**Statut global** : ✅ livré 2026-05-21 (étapes 1, 2, 3, 4a, 4b, 6).
⏳ Reste 5 (UI panel revoke), 7 (template email Notifuse), 8 (E2E complet),
9 (doc API consommatrice).

```
┌───────────────────────────────────────────────────────────────┐
│ 1. Notifuse → Hub                                              │
│    POST /api/invitations/create                                │
│    Auth: x-veridian-invitation-signature HMAC                  │
│          x-veridian-app=notifuse                               │
│    Body: { inviter_user_id, inviter_email, invitee_email,      │
│            target_app=notifuse, target_workspace_id,           │
│            target_role=member }                                │
│    →   201 { token, magic_link_url, expires_at }               │
│       (ou 200 reused:true si invitation pending existe)        │
└────────────────────────────┬───────────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ 2. Notifuse envoie email "Rejoignez l'équipe X sur Veridian"   │
│    (template MJML — étape 7 en cours côté agent Notifuse)      │
│    CTA: <magic_link_url> = https://app.veridian.site/invite/X  │
└────────────────────────────┬───────────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ 3. Invitee click magic link → page Hub /invite/[token]         │
│    Front : GET /api/invitations/[token]/verify                 │
│    →   200 { valid:true, invitation:{ invitee_email,           │
│              target_app, target_workspace_id, inviter:{...} }} │
│    Si pas de session → redirect /signin?callback=/invite/X     │
└────────────────────────────┬───────────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ 4a. Invitee click "Accepter"                                    │
│    POST /api/invitations/[token]/accept                        │
│    Auth: session Hub                                            │
│    Body: {} ou { allow_email_mismatch:true } si UI override    │
│                                                                 │
│    Hub résout supabaseUserId (UUID bridge cross-app)            │
│    → si manquant → 409 user_not_provisioned                    │
└────────────────────────────┬───────────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ 4b. Hub propage via attachMemberDownstream(target_app, ...)    │
│    POST https://<app>.app.veridian.site/api/veridian/          │
│         workspaces/<workspace_id>/attach-member                │
│    Auth: HMAC m2m Pattern A                                     │
│    Body: { hub_user_id, hub_user_email, role, invitation_id }  │
│                                                                 │
│    Result downstream:                                           │
│    - completed → 200 ok=true + redirect_url=login_url           │
│    - pending   → 202 + redirect_url=home app                   │
│    - error     → 502 + downstream_error_code                   │
└────────────────────────────┬───────────────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ 5. UI redirect vers redirect_url (auto-login app)              │
│    Invitee atterrit logged dans le workspace                   │
└─────────────────────────────────────────────────────────────────┘
```

**Audit** : `audit_log` event `invitation.cross_app.accept` avec
`downstream_call`, `downstream_http_status`, `email_mismatch`.

**Tests existants** :
- `__tests__/api/invitations/create.test.ts`
- `__tests__/api/invitations/accept.test.ts`
- `__tests__/api/invitations/[token].test.ts`
- `__tests__/api/invitations/revoke/[id].test.ts`
- `__tests__/lib/invitations/attach-downstream.test.ts`
- `__tests__/lib/invitations/hmac.test.ts`
- `e2e/staging-full/05-invitation-cross-app-flow.spec.ts`

---

### Flow 2 — Stripe upgrade (checkout → propagation downstream)

**Statut** : ✅ livré 2026-05-21 (orchestrateur Stripe).

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. User → page /pricing (Hub)                                    │
│    Click "Souscrire Pro"                                          │
│    Front : POST /api/billing/checkout                            │
│    Body: { plan:'veridian_pro_monthly', interval:'month' }       │
│    →   200 { url: 'https://checkout.stripe.com/c/pay/cs_...' }  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ 2. window.location = checkoutUrl                                 │
│    User saisit CB sur Stripe Checkout                             │
│    Stripe crée subscription avec metadata:                        │
│      { plan_key: 'veridian_pro_monthly',                          │
│        user_uuid: '<supabaseUserId>' }                            │
│    Stripe redirect → /dashboard/billing?checkout=success         │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ 3. Stripe webhook → POST /api/webhooks (Hub)                     │
│    Auth: Stripe-Signature whsec_...                              │
│    Event: customer.subscription.created                          │
│                                                                   │
│    Hub:                                                           │
│    a. constructEvent (signature OK)                              │
│    b. persistStripeEvent → INSERT stripe_events (PK event.id)    │
│    c. dispatchStripeEvent →                                       │
│       manageSubscriptionStatusChange(sub.id, customer)            │
│       → resync DB Hub (table subscriptions)                       │
│       → propagation HMAC parallèle:                              │
│         - Notifuse POST /api/tenants/update-plan                 │
│           plan=pro plan_source=stripe                            │
│         - Prospection POST /api/tenants/update-plan (si bundle)  │
│    d. markEventProcessed (processed_at=NOW())                    │
│    →   200 { received:true, outcome:'processed', eventId }      │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ 4. Apps downstream applique le plan                              │
│    - Notifuse update workspace.plan + quotas                      │
│    - Prospection update workspace.plan (n/a si pas bundle)        │
└──────────────────────────────────────────────────────────────────┘
```

**Idempotence** : Stripe retry 3× minimum si pas de 200. La persistance
PK `event.id` garantit qu'un retry trouve `alreadyProcessed=true` et
retourne 200 sans re-dispatch.

**Si propagation échoue** : retry 3× interne du `NotifuseClient` (backoff
1s/4s/16s). Si exhausted → alerte Telegram + `stripe_events.error` set.
Pas de 4xx vers Stripe (sinon retry inutile). Le **cron de retry**
(P2 à câbler) consommera la liste `WHERE processed_at IS NULL`.

**Tests existants** :
- `__tests__/lib/stripe/dispatcher.test.ts`
- `__tests__/utils/stripe/prisma-sync.test.ts`
- `__tests__/api/webhooks/route.test.ts`
- `e2e/staging-full/09-stripe-webhook-dispatcher.spec.ts`

---

### Flow 3 — Trial intelligent (5 mails → 15j visible → CB)

**Statut** : ✅ livré 2026-05-21 (état machine + cron tick + emails +
Telegram). Reste à brancher l'UPSERT `tenant_trials` dans le handler
WH-NOTIFUSE-V14 quand Notifuse émettra réellement
`tenant.activity_threshold_reached`.

**Référence** : `docs/PRICING-VERIDIAN.md` (source de vérité philosophie).

```
┌──────────────────────────────────────────────────────────────────┐
│ Jour 0 : Signup user                                              │
│   POST /api/auth/signup → User + Account + workspace par défaut  │
│   POST /api/tenants/start → tenants Notifuse + Prospection (Free) │
│   tenant_trials.state = NULL (pas encore trial)                   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ Jours 0-N : User envoie des mails dans Notifuse                  │
│   Notifuse compte → atteint seuil 5 mails                         │
│                                                                   │
│   Notifuse → POST /api/webhooks/tenant-activity (Hub)            │
│   Auth: Bearer NOTIFUSE_WEBHOOK_TOKEN                            │
│   Body: { event:'tenant.activity_threshold_reached',              │
│           data:{ metric:'emails_sent', threshold:5, value:5 } }   │
│                                                                   │
│   Hub handler → UPSERT tenant_trials                              │
│     state='eligible', first_signal_at=NOW()                       │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ +48h : silence intentionnel                                       │
│   Cron tick (30 min) parcourt tenant_trials WHERE                │
│     state='eligible' AND first_signal_at < NOW() - INTERVAL '48h'│
│   → state='trial_active'                                          │
│   → Hub propage update-plan Notifuse plan=pro                     │
│     plan_source='stripe_trial'                                    │
│   → email "Vous êtes en essai Pro 30j"                            │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│ Jour J+12 : email "expire dans 3j"                               │
│ Jour J+15 : check Stripe subscription                            │
│   - Si CB renseignée → débit auto → state='converted'             │
│   - Sinon → state='expired'                                       │
│     - Hub propage update-plan Notifuse plan=free                  │
│     - paywall obfusqué (§5.9) côté app                            │
└──────────────────────────────────────────────────────────────────┘
```

**Endpoints livrés** :
- `POST /api/cron/trial-tick` (cf [CRON-TRIAL](#cron-trial--post-apicrontrial-tick))
- Migration `prisma/migrations/20260521150000_add_tenant_trials/`
- `lib/trial/transitions.ts` + `lib/trial/constants.ts`
- Templates `lib/email/templates/trial.ts` (started / ending_soon / expired)
- Workflow `.github/workflows/hub-trial-tick-cron.yml` (toutes les 30 min)

**Tests existants** :
- `__tests__/lib/trial/transitions.test.ts`
- `__tests__/api/cron/trial-tick.test.ts`

---

```json
{
  "error": "string (code machine-readable, snake_case)",
  "message": "string (human-readable, fr)",
  "details": {
    "field": "string (optional, pour invalid_payload)",
    "expected": "string (optional)",
    "actual": "string (optional)"
  },
  "request_id": "string (X-Request-Id echo)"
}
```

Status HTTP standards :
- 200/201 succès
- 400 invalid_payload, validation_failed
- 401 unauthorized (HMAC fail, session manquante)
- 403 forbidden (session présente mais pas le bon role)
- 404 not_found (après auth check)
- 409 conflict (tenant_conflict_owner, plan_source_immutable, already_accepted)
- 410 gone (workspace soft_deleted)
- 423 locked (workspace_suspended)
- 429 rate_limited
- 500 internal_error

---

## Codes erreur cross-app

Liste exhaustive des codes erreur (`error` field) standardisés :

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | Auth fail (HMAC, Bearer, session) |
| `forbidden` | 403 | Auth OK mais permission insuffisante |
| `invalid_payload` | 400 | Zod fail générique |
| `validation_failed` | 400 | Validation business (email malformé, etc.) |
| `tenant_not_found` | 404 | tenant_id inconnu |
| `workspace_not_found` | 404 | workspace_id inconnu |
| `user_not_member` | 403 | user pas dans workspace |
| `tenant_conflict_owner` | 409 | provision avec owner différent |
| `plan_source_immutable` | 409 | Stripe peut pas downgrade lifetime_* |
| `transition_illegal` | 409 | machine à états refuse la transition |
| `cannot_remove_owner` | 409 | tentative remove sur owner |
| `invitee_already_member` | 409 | déjà membre |
| `already_accepted` | 409 | invitation déjà acceptée |
| `email_mismatch` | 409 | session email ≠ invitee email |
| `workspace_gone` | 410 | workspace soft_deleted |
| `token_invalid` | 410 | token expired/revoked/not_found/already_accepted |
| `workspace_suspended` | 423 | tenant suspendu pour billing |
| `purge_too_early` | 409 | garde-fou 30j minimum |
| `invalid_confirm_slug` | 400 | confirm_slug ne matche pas |
| `rate_limited` | 429 | rate limit dépassé |
| `internal_error` | 500 | erreur serveur |

---

## PERMS — Vérification des droits (§11bis du contrat)

> Section ajoutée v1.1 (2026-05-21 soir). Référence technique pour
> implémenter la matrice §11bis.2 du contrat.

### PERMS.1 Helpers obligatoires côté Hub

```typescript
// src/lib/auth/permissions.ts

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Lève 401 si pas de session Hub. */
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new HttpError(401, 'unauthorized');
  return session.user;
}

/** Lève 403 si user pas platform_admin. */
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden');
  return user;
}

/**
 * Lève 403 si user n'a pas un des roles autorisés sur le tenant.
 * roles autorisés : ('owner' | 'admin' | 'member')[]
 * Retourne le tenant_member row.
 */
export async function requireTenantRole(
  userId: string,
  tenantId: string,
  allowedRoles: ('owner' | 'admin' | 'member')[]
) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { userId: true },
  });
  if (!tenant) throw new HttpError(404, 'tenant_not_found');

  // Owner détection
  if (tenant.userId === userId) {
    if (allowedRoles.includes('owner')) return { role: 'owner' as const };
    throw new HttpError(403, 'forbidden');
  }

  // Member detection
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true, deletedAt: true },
  });
  if (!member || member.deletedAt) throw new HttpError(403, 'forbidden');
  if (!allowedRoles.includes(member.role as any)) throw new HttpError(403, 'forbidden');
  return { role: member.role };
}
```

### PERMS.2 Matrice par endpoint (Hub-side)

Pour chaque endpoint Hub où une session user agit sur un tenant :

| Endpoint Hub | Permission requise (§11bis.2.1) |
|---|---|
| `POST /api/invitations/create` (par session user) | `tenant_owner` OU `tenant_admin` sur le target_workspace tenant |
| `POST /api/invitations/[token]/accept` | session user (n'importe lequel) — vérif email match + token valide |
| `POST /api/invitations/revoke/[id]` | l'inviter (session user = `inviter_user_id`) OU `platform_admin` |
| `POST /api/admin/tenants/<id>/remove-member` | `tenant_owner` OU `tenant_admin` (sauf retrait owner) |
| `POST /api/admin/tenants/<id>/restore-member` | `tenant_owner` OU `tenant_admin` |
| `POST /api/admin/tenants/<id>/transfer-owner` | `tenant_owner` sortant uniquement |
| `POST /api/admin/tenants/<id>/promote` (futur) | `tenant_owner` uniquement |
| `POST /api/admin/tenants/<id>/plan` | `tenant_owner` OU `platform_admin` |
| `POST /api/tenants/<id>/soft-delete` (par user) | `tenant_owner` uniquement |
| `POST /api/admin/tenants/<id>/purge` | `platform_admin` uniquement |

### PERMS.3 Helpers côté app downstream

Les endpoints HMAC m2m (Hub → app) **ne vérifient PAS** les droits user
— c'est le Hub qui a vérifié en amont. Le HMAC suffit comme proof.

Les endpoints session user (app self-service, ex. UI Prospection
`/api/workspaces/<id>/leads`) **doivent** vérifier le rôle local :

```typescript
// Pattern app downstream
export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  allowedRoles: string[]
) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, deletedAt: true },
  });
  if (!member || member.deletedAt) throw new HttpError(403, 'forbidden');
  if (!allowedRoles.includes(member.role)) throw new HttpError(403, 'forbidden');
  return member;
}
```

### PERMS.4 Tests obligatoires

Pour chaque endpoint qui implémente une vérification de rôle :

- Test happy path : user a le rôle requis → 200
- Test forbidden : user authenticated mais pas le bon rôle → 403 `forbidden`
- Test 401 : pas de session → 401 `unauthorized`
- Test 404 : tenant/workspace inconnu → 404 (renvoyé APRÈS auth check)
- Test owner protection : si endpoint refuse de toucher l'owner, vérifier
  qu'il retourne 409 `cannot_remove_owner`
- Test self-action : si user agit sur lui-même (self-remove), vérifier
  comportement spécifique

### PERMS.5 Cas particuliers à graver

#### Email mismatch sur accept invitation

Cf §11bis.4.1 du contrat. Implémentation :

```typescript
const invitation = await prisma.crossAppInvitation.findUnique({ where: { token } });
if (!invitation) throw new HttpError(410, 'token_invalid');

const session = await requireUser();

// Email match strict par défaut
if (session.email !== invitation.inviteeEmail) {
  const { searchParams } = new URL(req.url);
  const forceLink = searchParams.get('force_link') === 'true';
  if (!forceLink) {
    throw new HttpError(409, 'email_mismatch', JSON.stringify({
      expected: invitation.inviteeEmail,
      actual: session.email,
      override_url: `/invite/${token}?force_link=true`,
    }));
  }
  // Log audit explicite
  await prisma.auditLog.create({
    data: {
      action: 'invitation.email_overridden',
      actorId: session.id,
      metadata: { invitation_id: invitation.id, expected: invitation.inviteeEmail },
    },
  });
}
```

#### Self-remove vs remove-owner

```typescript
// POST /api/admin/tenants/<id>/remove-member
const target = req.body.email;
const session = await requireUser();

if (target === session.email) {
  // Self-remove autorisé tant que pas owner
  if (await isTenantOwner(session.id, tenantId)) {
    throw new HttpError(409, 'cannot_remove_owner_self');
  }
  // Pas de garde-fou rôle (un member peut quitter)
} else {
  // Action sur un autre membre : require tenant_owner ou tenant_admin
  await requireTenantRole(session.id, tenantId, ['owner', 'admin']);
  if (await isTenantOwner(target, tenantId)) {
    throw new HttpError(409, 'cannot_remove_owner');
  }
}
```

---

## Matrice de statut par endpoint

> **Vue d'ensemble cross-app + Hub-locaux**. À lire en premier quand on
> arrive sur le repo Hub pour savoir ce qui est livrable, ce qui est
> partiel, et ce qui est juste spec. Cross-référence §10 du contrat.
>
> Légende :
> - ✅ **livré** — code en prod + tests verts
> - 🟡 **partiel** — endpoint en place mais comportement incomplet (gap doc explicité)
> - ⏳ **en cours** — ticket actif identifié, agent dédié assigné
> - 🔵 **stub** — endpoint accepte les calls (200) mais effet de bord pas câblé
> - ❌ **non prévu** — pas de ticket, pas dans la roadmap actuelle

### Endpoints contractuels Hub → apps downstream (HMAC m2m)

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| PROV | POST /api/tenants/provision (app) | ✅ | unit (Notifuse) + E2E | Notifuse OK, Prospection OK |
| PLAN | POST /api/tenants/update-plan (app) | ✅ | unit | Notifuse OK ; Prospection livré côté agent, push HMAC depuis Hub pas encore branché (cf `todo/integrations/prospection-update-plan-2026-05-18.md`) |
| OWN | POST /api/tenants/attach-owner (app) | 🟡 | manual repair script | `scripts/admin/repair-notifuse-owners.sh` |
| SUSP | POST /api/tenants/suspend (app) | ✅ | unit | Notifuse OK |
| RES | POST /api/tenants/resume (app) | ✅ | unit | Notifuse OK |
| HEALTH | GET /api/tenants/{id}/health (app) | 🟡 | — | Notifuse expose status — cron 1×/h pas encore actif Hub-side |
| MAGIC | POST /api/workspaces.generateMagicLink (app) | ✅ | unit | Notifuse OK |
| SOFT | POST /api/tenants/{id}/soft-delete (app) | 🟡 | — | spec graveée, implé partielle (Notifuse delete = soft-delete legacy 30j) |
| REST | POST /api/tenants/{id}/restore (app) | ⏳ | — | spec graveée, pas d'implé |
| PURGE | POST /api/tenants/{id}/purge (app) | ⏳ | — | spec — décision Robert manuelle, pas auto |
| TOUCH | POST /api/webhooks/<app>/tenant.touched (Hub) | 🔵 | unit (receiver) | handler stub côté Hub (cf WH-NOTIFUSE-V14) |
| USAGE | GET /api/tenants/{id}/usage-summary (app) | ⏳ | — | spec — Notifuse expose `emails_sent_this_month`, format à standardiser |
| USER | GET /api/users/{hub_user_id} (Hub) | ⏳ | — | Pas encore exposé côté Hub, spec graveée |
| EMAIL | GET /api/users/by-email (app) | ⏳ | — | Niveau 1 Discovery — tickets dans chaque app downstream (cf `todo/2026-05-20-hub-discovery-by-email-pattern.md`) |
| ROT | POST /api/tenants/{id}/rotate-api-key (app) | ❌ | — | Pas planifié — utiliser repair script si compromise |
| TRANS | POST /api/tenants/{id}/transfer-owner (app) | ⏳ | — | spec graveée, pas d'implé |
| SYNC | POST /api/tenants/{id}/sync-member (app) | ⏳ | — | spec graveée pour invite admin Hub §5.18.2 |
| RM | POST /api/tenants/{id}/remove-member (app) | ⏳ | — | spec graveée §5.19.2 |
| RESTM | POST /api/tenants/{id}/restore-member (app) | ⏳ | — | spec graveée §5.20 |
| FREEZE | POST /api/tenants/{id}/freeze-members (app) | ❌ | — | spec graveée §5.21, pas planifié court terme |
| UNFREEZE | POST /api/tenants/{id}/unfreeze-members (app) | ❌ | — | idem |

### Endpoints invitation cross-app (P1, §5.22)

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| INV-CREATE | POST /api/invitations/create (Hub) | ✅ | unit + E2E | sprint v1.4 étape 2, HMAC m2m apps → Hub |
| INV-VERIFY | GET /api/invitations/[token]/verify (Hub) | ✅ | unit | étape 3, public anti-leak |
| INV-ACCEPT | POST /api/invitations/[token]/accept (Hub) | ✅ | unit + E2E | étape 4a+4b livrée 2026-05-21, hotfix UUID supabase 5c9c68e |
| INV-REVOKE | POST /api/invitations/revoke/[id] (Hub) | ✅ | unit | étape 6, forbidden-prioritaire |
| ATTACH | POST /api/veridian/workspaces/[id]/attach-member (app) | 🟡 | unit côté Hub | Hub call OK, downstream livré côté Notifuse, Prospection à valider |

### Webhooks app → Hub

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| WH-NOTIFUSE-V14 | POST /api/webhooks/notifuse (Bearer v1.4) | ✅ | unit + E2E | Dispatcher v1.4 livré 2026-05-21, handlers stubs (effets de bord à brancher) |
| WH-NOTIFUSE-LEGACY | POST /api/webhooks/notifuse (HMAC legacy) | ✅ | unit | Coexistence — à retirer en v1.5 |
| WH-PROSP-V14 | POST /api/webhooks/prospection (Bearer v1.4) | ✅ | E2E | Stubs handlers — agent Prospection à brancher events réels |
| WH-TENANT-ACTIVITY | (via WH-NOTIFUSE-V14) | 🟡 | unit | Stub handler — UPSERT `tenant_trials` à brancher quand Notifuse émettra l'event |

### Webhooks Stripe → Hub

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| STRIPE-WH | POST /api/webhooks | ✅ | unit + E2E | Orchestrateur livré 2026-05-21, idempotence stripe_events PK, dispatcher → Notifuse/Prospection HMAC |

### Endpoints Hub-locaux : Billing & Pricing

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| BILLING-CHECKOUT | POST /api/billing/checkout | ✅ | unit + validation | Plan source vérifiée (lifetime_* refusés) |
| PRICING-PLANS | GET /api/pricing/plans | ✅ | unit | ISR 1h, fallback côté Notifuse Go |

### Endpoints Hub-locaux : Provisioning (session user)

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| TENANT-START | POST /api/tenants/start | ✅ | unit + E2E | Click manuel "Commencer l'essai" — remplace auto-provision signup |
| TENANT-RETRY | POST /api/tenants/retry | ✅ | unit | Recovery partial failure |
| TENANT-STATUS | GET /api/tenants/status | ✅ | — | Front dashboard provisioning |
| NOTIFUSE-CREATE | POST /api/notifuse/create-tenant | 🟡 | unit | Legacy — à réabsorber dans TENANT-START quand multi-tenant supporté |
| PROSPECTION-REGEN | POST /api/prospection/regenerate-login | ✅ | unit | Fresh login_url |

### Endpoints Hub-locaux : Admin API

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| ADMIN-USER-CREATE | POST /api/admin/users/create | ✅ | unit + E2E | Livré 2026-05-20, idempotent, audit log |
| ADMIN-USER-GET | GET /api/admin/users/[email] | ✅ | unit | Read-only, retourne user + tenants |
| ADMIN-TENANT-LINK | POST /api/admin/tenants/link-app | ✅ | unit | Idempotent, audit log |
| ADMIN-TENANT-UNLINK | DELETE /api/admin/tenants/unlink-app | ✅ | unit | Soft unlink, row Tenant préservée |
| ADMIN-AUDIT | GET /api/admin/audit-log | ✅ | unit | Index par actor + created_at |
| ADMIN-LIST-TENANTS | GET /api/admin/list-tenants | ✅ | unit | Dashboard ops |
| ADMIN-DELETE-TENANT | DELETE /api/admin/delete-tenant | ✅ | unit | Destructif, cascade Auth user. Workspace Notifuse non touché (cleanup manuel) |
| ADMIN-GRANT-PLAN | POST /api/admin/grant-plan | 🟡 | unit | **Deprecated** — alias vers ADMIN-TENANT-PLAN |
| ADMIN-TENANT-PLAN | POST /api/admin/tenants/[id]/plan | ✅ | unit | Unifié notifuse+prospection. Push HMAC Prospection pas encore câblé |
| ADMIN-IMPERSONATE | POST /api/admin/impersonate | 🟡 | unit | Prospection/Notifuse OK, Hub `/api/auth/impersonate-callback` pas livré (TODO LOT D) |
| ADMIN-ORPHANS | GET /api/admin/users/orphans | ✅ | unit | Read-only review manuelle |
| ADMIN-NOTIFUSE-STATUS | GET /api/admin/notifuse/status | ✅ | unit | Read-through HMAC fork |
| ADMIN-NOTIFUSE-SUSPEND | POST /api/admin/notifuse/suspend | ✅ | unit | Suspend HMAC + metadata |
| ADMIN-NOTIFUSE-RESUME | POST /api/admin/notifuse/resume | ✅ | unit | Resume HMAC + clear marqueurs |
| ADMIN-NOTIFUSE-DELETE | DELETE /api/admin/notifuse/delete | ✅ | unit | Soft-delete HMAC (30j rétention fork) |
| ADMIN-NOTIFUSE-PLAN | POST /api/admin/notifuse/update-plan | ✅ | unit | Push plan + audit history (max 50) |
| ADMIN-NOTIFUSE-MAGIC | POST /api/admin/notifuse/magic-link | ✅ | unit | Owner ou platform admin |

### Endpoints Hub-locaux : Workspace interne (session user)

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| WS-INVITE | POST /api/workspace/invite | ✅ | unit | Modèle Invitation distinct de CrossAppInvitation |
| WS-ACCEPT | POST /api/workspace/invite/accept | ✅ | unit | Email match strict, atomique |
| WS-MEMBER-PATCH | PATCH /api/workspace/members/[id] | ✅ | unit | Role hierarchy via `canChangeRole` |
| WS-MEMBER-DELETE | DELETE /api/workspace/members/[id] | ✅ | unit | Refuse retrait OWNER |
| WS-PROVISION | (au signup) | ✅ | unit | `provisionDefaultWorkspace` best-effort 2026-05-21 |

### Endpoints Hub-locaux : Account & Auth

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| ACCOUNT-PROFILE | PATCH /api/account/profile | ✅ | unit | Email change force re-verify |
| ACCOUNT-PASSWORD | POST /api/account/password | ✅ | unit | Bcrypt 12 rounds, créa Account credentials si absent |
| ACCOUNT-PROVIDERS-LIST | GET /api/account/connected-providers | ✅ | unit | Sans tokens |
| ACCOUNT-PROVIDER-DELETE | DELETE /api/account/connected-providers/[provider] | ✅ | unit | Anti-lockout transactionnel |
| ACCOUNT-RECENT-SUB | GET /api/account/recent-subscription | ✅ | unit | PurchaseTracker GA4 |
| AUTH-NEXTAUTH | * /api/auth/[...nextauth] | ✅ | unit + E2E | Handler Auth.js v5 |
| AUTH-SIGNUP | POST /api/auth/signup | ✅ | unit + E2E | Rate-limited 5/min/IP, workspace par défaut |
| AUTH-MFA-TOGGLE | POST /api/auth/mfa/toggle | ✅ | unit | Session required |
| AUTH-MFA-VERIFY | POST /api/auth/mfa/verify | ✅ | unit | Cookie 5min |
| AUTH-MFA-RESEND | POST /api/auth/mfa/resend | ✅ | unit | Rate-limited 5/h/user |

### Endpoints Hub-locaux : Cron & Service

| ID | Endpoint | Statut | Tests | Notes |
|---|---|---|---|---|
| CRON-ORPHANS | POST /api/cron/cleanup-orphan-users | ✅ (dry-run) | unit | Délibérément passif — delete manuel |
| CRON-TRIALS | POST /api/cron/cleanup-trials | 🟡 | unit | Notifuse-only legacy — superseded par CRON-TRIAL |
| CRON-TRIALS-INFO | GET /api/cron/cleanup-trials | ✅ | — | Public, status endpoint |
| CRON-TRIAL | POST /api/cron/trial-tick | ✅ | unit | Trial state machine 30 min, FOR UPDATE SKIP LOCKED |
| HEALTH-HUB | GET /api/health | ✅ | unit | Gate Docker + smoke CI/CD |
| CONFIG | GET /api/config | ✅ | unit | NEXT_PUBLIC_* runtime |

### Comptage global

| Statut | Cross-app contractuel | Invitation P1 | Webhooks | Hub-locaux | **Total** |
|---|---|---|---|---|---|
| ✅ livré | 6 | 4 | 4 | 33 | **47** |
| 🟡 partiel | 3 | 1 | 1 | 4 | **9** |
| ⏳ en cours | 9 | — | — | — | **9** |
| 🔵 stub | 1 | — | — | — | **1** |
| ❌ non prévu | 3 | — | — | — | **3** |
| **Total** | **22** | **5** | **5** | **37** | **69** |

> Couverture livrée : **47/69 ≈ 68%**. Le gap 22 endpoints restants
> concerne essentiellement la machinerie multi-membre cross-app (§5.18-5.21
> du contrat) et la migration legacy → v1.4 du fork Notifuse — pas
> bloquant pour le SaaS actif (Free/Pro/Business mono-membre).

---

## Changements

### v1.2 — 2026-05-21 (nuit)

- Ajout section **Endpoints Hub-locaux** : ~30 routes Hub-side documentées
  (Stripe webhook orchestrator, webhooks v1.4 Bearer, Billing/Pricing,
  Provisioning session user, Admin API complète, Workspace interne,
  Account/Auth, Cron, Service).
- Ajout section **Flows E2E** : 3 scénarios bout-en-bout (Invitation
  cross-app, Stripe upgrade, Trial intelligent).
- Ajout section **Matrice de statut par endpoint** : 68 endpoints
  totalisés (46 ✅ / 8 🟡 / 10 ⏳ / 1 🔵 / 3 ❌).
- Met à jour la TOC pour refléter les nouvelles sections.

### v1.1 — 2026-05-21 (soir)

- Ajout section **PERMS** : helpers `requireUser`, `requireAdmin`,
  `requireTenantRole`, `requireWorkspaceRole`. Matrice endpoint → droit requis.
  Cas particuliers email mismatch + self-remove avec code de référence.
- Pas de changement sur les endpoints existants — section purement
  additionnelle qui sert §11bis du contrat v1.5.

### v1.0 — 2026-05-21

Document initial. Extrait les schemas request/response détaillés du
CONTRAT-HUB.md v1.4 + ajoute :
- Exemples curl reproductibles pour Pattern A
- Code Node.js verifyHmac de référence
- Liste exhaustive des codes erreur cross-app
- Notes par app sur les divergences Prospection/Notifuse
- Documentation des endpoints P1 invitation (INV-CREATE, INV-VERIFY,
  INV-ACCEPT, INV-REVOKE, ATTACH).

---

## Source primaire & maintenance

- **Code applicatif** : `veridian-hub/app/api/` — quand une route bouge
  côté Hub, mettre à jour la section correspondante de ce document **dans
  le même commit**.
- **Tickets de référence** : `veridian-hub/todo/` (pending) + `done/`
  (archive). Le ticket d'origine est linké dans la section "Statut" de
  chaque endpoint.
- **Tests E2E** : `e2e/staging-full/` (Playwright headfull staging).
  Chaque scénario E2E couvre un flow décrit dans la section "Flows E2E".
- **Audit** : tout endpoint sous `/api/admin/*` ou `/api/invitations/*`
  écrit dans `hub_app.audit_log` via `writeAuditLog`. Consultable via
  `GET /api/admin/audit-log?actor=...`.
