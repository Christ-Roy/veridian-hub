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
> **Version** : 1.1 (2026-05-21 soir) — ajout section PERMS.
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
- [Format d'erreurs standardisé](#format-derreurs-standardisé)
- [Codes erreur cross-app](#codes-erreur-cross-app)
- [PERMS — Vérification des droits (§11bis du contrat)](#perms--vérification-des-droits-11bis-du-contrat)

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
  "emitted_at": "ISO8601",
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

## Format d'erreurs standardisé

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

## Changements

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
