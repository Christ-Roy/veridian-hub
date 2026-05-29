# Route admin Hub `POST /api/admin/crm/create-tenant`

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Mis à jour** : 2026-05-27 (flow validé bout-en-bout sur staging réel)
> **Demandeur** : agent veridian-crm
> **Statut staging** : ✅ Twenty fork déployé et fonctionnel sur `https://crm.staging.veridian.site` — flow 6 étapes testé en direct, tenant Robert créé, lead poussé via REST.

## TL;DR — Ce qui marche en réel (testé 2026-05-27)

✅ Tu peux créer un tenant Twenty complet (user + workspace activé + API key Bearer 1 an) en **6 appels GraphQL séquentiels sur `/metadata`** depuis le Hub, sans toucher au code Twenty.

✅ Le Bearer token retourné permet de pousser/lire de la data via `/rest/*` (validé : `POST /rest/people` créé un lead avec succès).

✅ Magic link auto-login fonctionne via `getLoginTokenFromCredentials` (mot de passe random stocké côté Hub, jamais montré à l'user).

Tu n'as **pas** besoin de :
- HMAC bidirectionnel
- Endpoints obligatoires côté Twenty
- Modif du code AGPL Twenty (sauf en vague 3 pour le guard signup-only)
- Webhook Stripe orchestrator
- Provisioning HMAC du contrat Hub strict

C'est de l'API consumption pure.

## Contexte

Veridian CRM est un fork de Twenty (AGPLv3) déployé en staging sur
`crm.staging.veridian.site`. Le signup public côté Twenty est bloqué par
Traefik (redirect `/welcome` → Hub). **Tout signup CRM doit donc passer
par le Hub.**

Use case immédiat Robert (gravé 2026-05-27) :

> "Je vais créer avec toi via api les tenants de notre stack et je vais
> leur faire un travail sur mesure de création de tenant crm avec les
> bonnes data, et leur mettre des prospects qualifiés dans leur crm à la
> main."

Pas d'UI dashboard self-service en vague 1. Robert provision les tenants
**manuellement** via cette route admin Hub, puis utilise l'API REST
Twenty (Bearer API key retournée) pour pousser de la data custom (leads
qualifiés, contacts, pipeline, vues, custom objects) dans le tenant.

## Code legacy de référence

Sauvegardé dans le repo CRM : `docs/legacy-twenty-hub-integration/`
- `create-tenant-v1.16-legacy.ts` — implémentation v1.16 (avant la sortie de Twenty 2026-05-18)
- `regenerate-login-v1.16-legacy.ts` — regénération magic link
- `README.md` — diff v1.16 vs v2.8 (mutations renommées, endpoints différents)

⚠️ Le legacy était écrit pour Twenty v1.16. On est sur v2.8. **Ne pas
recopier les payloads tels quels** — lire la section "Flow 6 étapes
validé en réel" ci-dessous pour les vrais noms à utiliser.

## Spec

### Endpoint

`POST /api/admin/crm/create-tenant`

### Auth

`HUB_ADMIN_TOKEN` Bearer (mode admin existant, cf `veridian-hub/lib/admin/`).
Trace dans `audit_logs` avec `actor='admin:robert.brunon@veridian.site'`
ou `actor='token:HUB_ADMIN_TOKEN'`.

### Request body

```json
{
  "email": "client@example.com",
  "workspaceName": "Acme Corp"
}
```

**Note** : pas besoin de passer `workspaceSlug` — Twenty v2.8 extrait le
subdomain automatiquement du domaine email (`@acme.com` → subdomain `acme`).
Tu peux le valider en consultant `workspaceUrls.subdomainUrl` dans la
réponse de `signUpInWorkspace`.

Pas besoin de passer `password` non plus — le Hub en génère un aléatoire
qu'il **ne stocke pas** (jamais utilisé : l'user passe exclusivement par
magic link).

### Response 201

```json
{
  "tenantId": "<uuid Hub>",
  "twentyWorkspaceId": "a89ddd99-960b-46a4-a6a6-1696b02cd9c5",
  "twentyWorkspaceUrl": "https://veridian.crm.staging.veridian.site/",
  "twentyApiKeyId": "3208b4fe-1423-4de7-91e1-c3d6344729a6",
  "twentyApiKeyExpiresAt": "2027-05-27T09:44:24.000Z",
  "magicLinkUrl": "https://veridian.crm.staging.veridian.site/verify?loginToken=eyJh...",
  "createdAt": "2026-05-27T09:43:00Z"
}
```

⚠️ La `twentyApiKey` (Bearer token réel, ~600 chars) **n'est PAS retournée
dans la response**. Elle est stockée chiffrée côté Hub et exposée
uniquement via un endpoint séparé `GET /api/admin/crm/tenants/{id}/api-key`
(audit log obligatoire à chaque appel) si Robert en a besoin pour ses
opérations data.

### ENV à ajouter côté Hub

```
CRM_METADATA_URL=https://crm.staging.veridian.site/metadata
CRM_REST_URL=https://crm.staging.veridian.site/rest
CRM_FRONTEND_URL=https://crm.staging.veridian.site
# Pas de CRM_HUB_API_SECRET ni HMAC — le pattern est API consumption pure
```

En prod (plus tard) :
```
CRM_METADATA_URL=https://crm.veridian.site/metadata
CRM_REST_URL=https://crm.veridian.site/rest
CRM_FRONTEND_URL=https://crm.veridian.site
```

## 🎯 Flow 6 étapes validé en réel (à coder ainsi côté Hub)

> Chaque étape testée le 2026-05-27 sur staging. Les exemples curl
> ci-dessous sont reproductibles tels quels.

### Étape 1 — `signUpInWorkspace` (crée user + 1er workspace)

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : aucune (CaptchaGuard bypass si pas de ENV captcha)

```graphql
mutation SignUp($email: String!, $password: String!) {
  signUpInWorkspace(email: $email, password: $password) {
    loginToken { token expiresAt }
    workspace {
      id
      workspaceUrls { subdomainUrl }
    }
  }
}
```

```bash
curl -sX POST https://crm.staging.veridian.site/metadata \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation SignUp($email: String!, $password: String!) { signUpInWorkspace(email: $email, password: $password) { loginToken { token expiresAt } workspace { id workspaceUrls { subdomainUrl } } } }",
    "variables": {"email": "client@example.com", "password": "<RANDOM_32_BYTES>"}
  }'
```

**À conserver** :
- `loginToken.token` → JWT court (15 min) pour échanger contre workspace token
- `workspace.id` → UUID du workspace côté Twenty
- `workspace.workspaceUrls.subdomainUrl` → URL frontend du tenant (ex. `https://acme.crm.staging.veridian.site/`)

⚠️ Le password généré par le Hub n'est **pas stocké**. Il sert
uniquement pour générer des magic links à la demande via Étape 7 (voir
plus bas). Pour le retrouver, il faudrait le reset → préférer regénérer
un magic link directement.

### Étape 2 — `getAuthTokensFromLoginToken` (échange loginToken contre access token)

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : aucune (publique, validation interne du loginToken JWT)

```graphql
mutation GetTokens($loginToken: String!, $origin: String!) {
  getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
    tokens {
      accessOrWorkspaceAgnosticToken { token }
      refreshToken { token }
    }
  }
}
```

```bash
curl -sX POST https://crm.staging.veridian.site/metadata \
  -H "Content-Type: application/json" \
  -d '{
    "query": "...",
    "variables": {
      "loginToken": "<TOKEN_FROM_STEP_1>",
      "origin": "<workspaceUrls.subdomainUrl from step 1>"
    }
  }'
```

**À conserver** : `accessOrWorkspaceAgnosticToken.token` → workspace-scoped JWT, valide 30 min. Utilisé pour les étapes 3-6 qui requièrent auth.

### Étape 3 — `activateWorkspace` (nomme + active le workspace)

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : `Authorization: Bearer <accessToken from step 2>`

```graphql
mutation ActivateWorkspace($input: ActivateWorkspaceInput!) {
  activateWorkspace(data: $input) {
    id
    displayName
    activationStatus
  }
}
```

```bash
curl -sX POST https://crm.staging.veridian.site/metadata \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{
    "query": "...",
    "variables": {"input": {"displayName": "Acme Corp"}}
  }'
```

**Doit retourner** : `activationStatus: "ACTIVE"`.

### Étape 4 — `getRoles` (récupère le rôle Admin pour l'API key)

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : `Authorization: Bearer <accessToken>`

```graphql
query GetRoles {
  getRoles { id label }
}
```

⚠️ Twenty v2.8 retourne **2 rôles** : `Member` puis `Admin`. **Toujours
filter `r.label === 'Admin'`** pour récupérer l'Admin role ID. Le legacy
v1.16 prenait `roles[0]` mais ça donne `Member` aujourd'hui = API key
sans pouvoirs admin.

```javascript
const adminRole = roles.find(r => r.label === 'Admin');
if (!adminRole) throw new Error('Admin role not found — workspace probably not activated');
const adminRoleId = adminRole.id;
```

### Étape 5 — `createApiKey` (crée l'API key admin du workspace)

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : `Authorization: Bearer <accessToken>`

```graphql
mutation CreateApiKey($input: CreateApiKeyInput!) {
  createApiKey(input: $input) {
    id
    name
    expiresAt
  }
}
```

⚠️ **Type renommé** : `CreateApiKeyDTO` (v1.16) → `CreateApiKeyInput` (v2.8).

```bash
EXPIRES_AT=$(date -u -d "+1 year" "+%Y-%m-%dT%H:%M:%SZ")
curl -sX POST https://crm.staging.veridian.site/metadata \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d "{
    \"query\": \"...\",
    \"variables\": {
      \"input\": {
        \"name\": \"Veridian Hub Admin Key\",
        \"expiresAt\": \"$EXPIRES_AT\",
        \"roleId\": \"<ADMIN_ROLE_ID from step 4>\"
      }
    }
  }"
```

**À conserver** : `createApiKey.id` → UUID de l'API key (utilisé étape 6).

### Étape 6 — `generateApiKeyToken` (génère le Bearer token réel)

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : `Authorization: Bearer <accessToken>`

```graphql
mutation GenerateApiKeyToken($apiKeyId: UUID!, $expiresAt: String!) {
  generateApiKeyToken(apiKeyId: $apiKeyId, expiresAt: $expiresAt) {
    token
  }
}
```

```bash
curl -sX POST https://crm.staging.veridian.site/metadata \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{
    "query": "...",
    "variables": {
      "apiKeyId": "<API_KEY_ID from step 5>",
      "expiresAt": "<EXPIRES_AT — same as step 5>"
    }
  }'
```

**À conserver** : `token` → **C'est LE Bearer token réel**, à stocker
chiffré côté Hub. JWT type=`API_KEY`, lifespan = `expiresAt` choisi
(recommandé : 1 an).

### Étape 7 (à la demande) — Regénération magic link

Quand Robert veut renvoyer un lien à un client :

**Endpoint** : `POST $CRM_METADATA_URL`
**Auth** : aucune (publique, on présente email + password Hub-stocké)

```graphql
mutation GetLoginToken($email: String!, $password: String!, $origin: String!) {
  getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) {
    loginToken { token expiresAt }
  }
}
```

⚠️ Le legacy v1.16 utilisait `signIn` — c'est devenu
`getLoginTokenFromCredentials` en v2.x, et l'arg `origin` est désormais
**obligatoire** (sinon : `Field "..." argument "origin" of type "String!"
is required`).

```bash
curl -sX POST https://crm.staging.veridian.site/metadata \
  -H "Content-Type: application/json" \
  -d '{
    "query": "...",
    "variables": {
      "email": "client@example.com",
      "password": "<PASSWORD STOCKÉ PAR LE HUB>",
      "origin": "<workspaceUrls.subdomainUrl>"
    }
  }'
```

**Magic link à donner à l'user** :
```
<origin>verify?loginToken=<loginToken.token>
```

Valide 15 min. Exemple :
```
https://acme.crm.staging.veridian.site/verify?loginToken=eyJhb...
```

**⚠️ Décision conception** : pour cette regénération à la demande, le
Hub DOIT stocker le password (chiffré, jamais affiché). Alternative
plus propre : utiliser `emailPasswordResetSession` qui envoie un email
de reset (mais ajoute friction). Recommandation : pour le moment garder
le password chiffré, c'est OK car aucun user ne se logge jamais en
direct via password — c'est uniquement pour le Hub.

## Test de validation après implémentation

Le Bearer token de l'étape 6 doit permettre :

```bash
# Lister les contacts (devrait retourner les seed Twenty + ce qu'on a poussé)
curl -X GET https://crm.staging.veridian.site/rest/people \
  -H "Authorization: Bearer <BEARER>"

# Créer un contact
curl -X POST https://crm.staging.veridian.site/rest/people \
  -H "Authorization: Bearer <BEARER>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": {"firstName": "Jean", "lastName": "Test-Lead"},
    "emails": {"primaryEmail": "jean@example.com"}
  }'
```

Si les deux marchent : ✅ le tenant est complet et le Bearer est admin.

## Schéma DB Hub à créer

```sql
-- Nouvelle table dédiée CRM (PAS dans la table Tenant existante qui est
-- scopée Notifuse + Prospection)
CREATE TABLE hub_app.crm_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES hub_app.users(id) ON DELETE CASCADE,
  twenty_workspace_id UUID NOT NULL UNIQUE,
  twenty_workspace_url TEXT NOT NULL,
  twenty_api_key_id UUID NOT NULL,
  twenty_api_key_encrypted TEXT NOT NULL,  -- AES-GCM avec HUB_ENCRYPTION_KEY
  twenty_api_key_expires_at TIMESTAMPTZ NOT NULL,
  twenty_password_encrypted TEXT NOT NULL,  -- pour regénérer magic links via étape 7
  workspace_display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | suspended | deleted
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_crm_tenants_user ON hub_app.crm_tenants(user_id);
CREATE INDEX idx_crm_tenants_workspace ON hub_app.crm_tenants(twenty_workspace_id);
```

Migration Prisma : `add-crm-tenants-table.sql` dans
`prisma/migrations/<timestamp>_add_crm_tenants_table/`.

## Tâches à implémenter

### T1. Migration Prisma `crm_tenants`

Spec : voir schéma DB ci-dessus.

### T2. Module `veridian-hub/lib/crm/client.ts`

Helpers à exposer :

```typescript
export interface CreateCrmTenantInput {
  email: string;
  workspaceName: string;
}

export interface CreateCrmTenantResult {
  twentyWorkspaceId: string;
  twentyWorkspaceUrl: string;
  twentyApiKeyId: string;
  twentyApiKeyToken: string;  // Bearer, à chiffrer par le caller
  twentyApiKeyExpiresAt: Date;
  passwordGenerated: string;   // à chiffrer par le caller
  initialMagicLinkUrl: string; // utilisable 15 min
}

export async function createCrmTenant(input: CreateCrmTenantInput): Promise<CreateCrmTenantResult>;

export async function regenerateMagicLink(
  email: string,
  passwordDecrypted: string,
  workspaceUrl: string,
): Promise<string>;  // URL prête à donner à l'user
```

Implémentation : enchaîner les 6 étapes en séquentiel avec retry léger
(3× backoff exponentiel) sur les erreurs réseau. Échec dur sur erreur
GraphQL (incluant l'erreur dans le message).

### T3. Route `app/api/admin/crm/create-tenant/route.ts`

- Vérifier `HUB_ADMIN_TOKEN` Bearer
- Générer password random (`crypto.randomBytes(32).toString('base64url')`)
- Appeler `createCrmTenant`
- Chiffrer `twentyApiKeyToken` + `passwordGenerated` avec `HUB_ENCRYPTION_KEY` (réutiliser `lib/utils/encryption.ts` si existant, sinon AES-256-GCM standard)
- INSERT dans `crm_tenants`
- Audit log `action='admin.crm.tenant.create'`
- Retourner la response 201 (sans le Bearer ni le password — voir spec response)
- Idempotence sur email : si tenant existe déjà pour cet email, retourner 200 avec le tenant existant (idem magic link regénéré)

### T4. Route compagnon `app/api/admin/crm/tenants/[id]/magic-link/route.ts`

- Vérifier `HUB_ADMIN_TOKEN`
- Charger `crm_tenants` par id
- Déchiffrer le password
- Appeler `regenerateMagicLink`
- Audit log `action='admin.crm.tenant.regenerate-magic-link'`
- Retourner `{ magicLinkUrl, expiresAt }`

### T5. Route compagnon `app/api/admin/crm/tenants/[id]/api-key/route.ts`

- Vérifier `HUB_ADMIN_TOKEN`
- Charger `crm_tenants` par id
- Déchiffrer le Bearer
- Audit log `action='admin.crm.tenant.reveal-api-key'`
- Retourner `{ apiKey, expiresAt, workspaceId, workspaceUrl }`

Cette route permet à Robert (et toi son agent) d'utiliser le Bearer
pour pousser de la data via `/rest/*` Twenty depuis ta session locale.

### T6. Test unitaire mockant le GraphQL

Mocker `fetch` pour retourner les payloads attendus à chaque étape. Vérifier :
- Chaîne des 6 appels effectivement déclenchée
- Idempotence sur email
- Password jamais stocké en clair
- API key chiffrée en DB
- Response 201 ne contient PAS le Bearer ni le password

### T7. Smoke E2E manuel après implémentation

```bash
# Sur ta machine locale, depuis veridian-hub :
export HUB_ADMIN_TOKEN=<celui des autres routes admin>
export HUB_URL=https://hub.staging.veridian.site

# 1. Créer un tenant
curl -X POST $HUB_URL/api/admin/crm/create-tenant \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "smoke-test@veridian.site", "workspaceName": "Smoke Test"}'

# 2. Récup le Bearer
TID=<tenantId from step 1>
curl -X GET $HUB_URL/api/admin/crm/tenants/$TID/api-key \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN"

# 3. Tester le Bearer sur Twenty REST
BEARER=<from step 2>
curl -X POST https://crm.staging.veridian.site/rest/people \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{"name": {"firstName": "Smoke", "lastName": "Lead"}, "emails": {"primaryEmail": "smoke@example.com"}}'

# 4. Regénérer le magic link
curl -X POST $HUB_URL/api/admin/crm/tenants/$TID/magic-link \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN"

# 5. Cleanup
# Supprimer manuellement le tenant créé (pas d'endpoint delete dans cette vague —
# v3 ajoutera DELETE /api/admin/crm/tenants/[id])
```

## Garde-fous

- **Ne pas** afficher le password Twenty en clair dans les logs
- **Chiffrer** la `twentyApiKey` + `password` en DB (AES-256-GCM avec `HUB_ENCRYPTION_KEY`)
- **Audit log obligatoire** pour CHAQUE appel (create, reveal-api-key, regenerate-magic-link)
- **Rate limit** sur les 3 routes (max 10/min depuis une même IP) au cas où `HUB_ADMIN_TOKEN` leak
- **Idempotence** : 2e call create avec même email retourne le tenant existant + regénère un magic link (pas d'erreur)
- **CaptchaGuard bypass** : ne PAS poser de ENV `CAPTCHA_DRIVER`/`CAPTCHA_SITE_KEY` côté staging Twenty. C'est déjà bon. Si jamais en prod on active Captcha, il faudra passer un token Captcha valide depuis le Hub (cassera ce flow → re-spec à ce moment-là)

## Non-objectifs (à NE PAS faire dans ce ticket)

- ❌ UI dashboard Hub self-service (vague 3)
- ❌ Webhook bidirectionnel Hub ↔ Twenty (vague 3)
- ❌ Suspend/resume/delete tenant
- ❌ Stripe checkout intégré (Veridian CRM = tout illimité pour l'instant)
- ❌ Renvoyer le Bearer dans la response de create-tenant (sécurité — endpoint dédié)
- ❌ Modifier le code Twenty (vague 3 si besoin)

## Référence — credentials du tenant de test créé 2026-05-27

Pour validation, voici le tenant créé en direct le 2026-05-27 avec ce flow :

| Champ | Valeur |
|---|---|
| Email | `robert.brunon@veridian.site` |
| Password (généré par l'agent) | `a6qFUW1jKFySXI9ui1VN` |
| Workspace URL | `https://veridian.crm.staging.veridian.site/` |
| Workspace ID | `a89ddd99-960b-46a4-a6a6-1696b02cd9c5` |
| API Key ID | `3208b4fe-1423-4de7-91e1-c3d6344729a6` |
| API Key Bearer expiry | `2027-05-27T09:44:24Z` (1 an) |

Quand tu auras codé la route, tu pourras soit garder ce tenant Robert
soit le supprimer via SQL pour repartir d'une DB Twenty propre pour ton
E2E :

```sql
-- Connexion postgres staging Twenty
DELETE FROM core."user" WHERE email='robert.brunon@veridian.site';
DELETE FROM core.workspace WHERE id='a89ddd99-960b-46a4-a6a6-1696b02cd9c5';
```

Le tenant Robert existant peut servir de validation : ta route Hub
appelée avec cet email doit détecter qu'il existe déjà côté Twenty et
soit retourner une erreur claire `tenant_exists`, soit regénérer un
magic link pour celui-ci (selon ta logique d'idempotence).
