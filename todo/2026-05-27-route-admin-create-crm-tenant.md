# Route admin Hub `POST /api/admin/crm/create-tenant`

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Dépend de** : ticket `veridian-crm-repo/todo/2026-05-27-deploy-staging-twenty-fork.md` (staging Twenty up sur `crm.staging.veridian.site`)
> **Demandeur** : agent veridian-crm

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

## Spec

### Endpoint

`POST /api/admin/crm/create-tenant`

### Auth

`HUB_ADMIN_TOKEN` Bearer (mode admin existant, cf
`veridian-hub/lib/admin/`). Trace dans `audit_logs` avec
`actor='admin:robert.brunon@veridian.site'` ou
`actor='token:HUB_ADMIN_TOKEN'`.

### Request body

```json
{
  "email": "client@example.com",
  "firstName": "Jean",
  "lastName": "Dupont",
  "workspaceName": "Acme Corp",
  "workspaceSlug": "acme-corp"
}
```

### Response 201

```json
{
  "tenantId": "<uuid Hub>",
  "twentyWorkspaceId": "<uuid Twenty>",
  "twentyWorkspaceSlug": "acme-corp",
  "twentyApiKey": "<bearer Twenty API key>",
  "twentyWorkspaceUrl": "https://acme-corp.crm.staging.veridian.site",
  "magicLinkUrl": "https://crm.staging.veridian.site/auth/token?t=...",
  "createdAt": "2026-05-27T10:00:00Z"
}
```

### Logique

1. Vérifier `HUB_ADMIN_TOKEN` valide
2. Vérifier qu'il n'existe pas déjà un tenant CRM pour cet email (idempotence sur email)
3. Appeler GraphQL Twenty :

```graphql
mutation SignUpInNewWorkspace($input: SignUpInNewWorkspaceInput!) {
  signUpInNewWorkspace(input: $input) {
    user { id, email }
    workspace { id, subdomain }
    loginToken { token, expiresAt }
  }
}
```

avec `input = { email, password: <random32bytes>, workspaceName, workspaceSlug }`.

⚠️ Twenty force la création d'un password. Le Hub génère un password
aléatoire (`crypto.randomBytes(32).toString('base64url')`) et **ne le
stocke pas**. L'user ne se logge JAMAIS avec ce password — il passe
exclusivement par magic link bouncé via Hub.

4. Récupérer le `loginToken` → construire le `magicLinkUrl`
5. Appeler GraphQL Twenty `mutation generateApiKeyToken` pour obtenir une API key admin du workspace nouvellement créé
6. INSERT en DB Hub :

```sql
-- Nouvelle table à créer dans une migration Prisma
CREATE TABLE hub_app.crm_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES hub_app.users(id) ON DELETE CASCADE,
  twenty_workspace_id UUID NOT NULL UNIQUE,
  twenty_workspace_slug TEXT NOT NULL UNIQUE,
  twenty_api_key_encrypted TEXT NOT NULL,  -- chiffré avec HUB_ENCRYPTION_KEY
  twenty_workspace_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | suspended | deleted
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Note : on N'utilise PAS la table `Tenant` existante (qui est scopée
Notifuse + Prospection avec des colonnes dédiées). On crée une table
séparée pour le CRM pour ne pas mélanger les concerns.

7. Retourner la réponse 201

### Erreurs

- 400 `EmailAlreadyHasCrmTenant`
- 502 `TwentyUnreachable`
- 502 `TwentyGraphQLError` + `details`
- 401 si HUB_ADMIN_TOKEN manquant/invalide

### ENV à ajouter côté Hub

- `CRM_GRAPHQL_URL` = `https://crm.staging.veridian.site/graphql`
- `CRM_API_URL` = `https://crm.staging.veridian.site` (pour magic link URLs)
- `CRM_ADMIN_BEARER_TOKEN` = une API key Twenty admin globale (à générer après le premier signup Twenty manuel par Robert, ou via cron Twenty si dispo)
- `HUB_ENCRYPTION_KEY` (probablement déjà présent — pour chiffrer `twenty_api_key`)

## Tâches

1. Migration Prisma : `add-crm-tenants-table`
2. Module `veridian-hub/lib/crm/client.ts` :
   - `signUpInNewWorkspace(input)` → appelle GraphQL Twenty
   - `generateApiKey(workspaceId)` → appelle GraphQL Twenty
   - `generateMagicLink(email)` → appelle GraphQL Twenty `emailPasswordResetSession` ou équivalent
   - Encryption helpers (réutiliser `lib/utils/encryption.ts` si existant)
3. Route `app/api/admin/crm/create-tenant/route.ts`
4. Test unitaire qui mock Twenty GraphQL et valide :
   - Idempotence sur email
   - Genère password random non-stocké
   - Stocke API key chiffrée
   - Retourne payload complet
5. Endpoint compagnon optionnel : `POST /api/admin/crm/regenerate-magic-link/{tenantId}` (pour quand Robert veut renvoyer un lien à un client)
6. Audit log entry pour chaque création
7. Doc dans `veridian-hub/docs/CRM-INTEGRATION.md` (créer le fichier) avec :
   - Commande curl d'exemple
   - Pattern d'usage (provisioning manuel par Robert)
   - Que faire avec la `twentyApiKey` retournée (POST data via REST Twenty)

## Tests E2E manuels

```bash
# 1. Créer un tenant
curl -X POST https://hub.staging.veridian.site/api/admin/crm/create-tenant \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test-robert@veridian.site",
    "firstName": "Robert",
    "lastName": "Test",
    "workspaceName": "Test CRM",
    "workspaceSlug": "test-crm"
  }'

# 2. Vérifier que le tenant est créé côté Twenty
curl https://crm.staging.veridian.site/rest/people \
  -H "Authorization: Bearer <twentyApiKey from step 1>"

# 3. Pousser un lead test
curl -X POST https://crm.staging.veridian.site/rest/people \
  -H "Authorization: Bearer <twentyApiKey>" \
  -H "Content-Type: application/json" \
  -d '{"name": {"firstName": "Jean", "lastName": "Lead"}, "emails": ["jean@lead.com"]}'

# 4. Cliquer le magicLinkUrl → atterrir loggé sur le tenant
```

## Garde-fous

- **Ne pas** stocker le password Twenty (il est random et jeté)
- **Chiffrer** la `twentyApiKey` en DB (jamais en clair)
- **Audit log obligatoire** pour chaque appel
- **Rate limit** sur la route (max 10/min depuis une même IP) pour éviter abus si le token leak
- **Idempotence** : 2e call avec même email doit retourner le tenant existant (200) ou 400 selon design

## Non-objectifs

- ❌ UI dashboard Hub self-service (vague 3)
- ❌ Webhook bidirectionnel Hub ↔ Twenty
- ❌ Suspend/resume/delete tenant (à ajouter quand le besoin apparaît)
- ❌ Stripe checkout intégré (Veridian CRM = tout illimité pour l'instant)
