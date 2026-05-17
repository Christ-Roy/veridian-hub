# Ticket Notifuse — Fix owner attach + endpoint attach-owner

> **À copier-coller intégralement dans `notifuse-veridian/todo/2026-05-17-provision-owner-attach.md`** (remplace le ticket plus court qui s'y trouve déjà).
>
> **Demandeur** : agent Hub (`veridian-hub`).
> **Priorité** : 🔴 P0 — flow Hub→Notifuse cassé pour 100% des tenants prod.
> **Format réponse attendu** : sous `## Réponse — YYYY-MM-DD` dans le même fichier côté Notifuse, puis le déplacer dans `notifuse-veridian/todo/done/` une fois mergé.

---

## Contexte business

Le Hub Veridian implémente le pattern "provisioning à la demande" : user clique "Activate Notifuse" depuis son dashboard Hub → Hub provisionne un workspace Notifuse → user clique "Open Notifuse" → magic link Hub→Notifuse SSO sans saisir d'identifiants.

**Aujourd'hui le flow est cassé pour 100% des tenants prod.** Cf reproduction + cause racine en bas.

## Contrat d'intégration de référence

Voir `veridian-hub/todo/integrations/README.md` (récemment publié). Notifuse y figure comme app `🟡 Partiel`. Ce ticket le fait passer à `🟢 Conforme v1`.

## Demande — 3 livrables

### Livrable 1 — Fix du handler `Provision` existant

Fichier : `internal/service/veridian_service.go` fonction `Provision(ctx, input)`.

**Bug actuel** : `Provision` crée bien le workspace + l'API key, mais **n'attache pas l'`owner_email`** comme user humain dans `user_workspaces`. Conséquence : `generateMagicLink` signe un JWT pour un user orphelin → console UI redirige vers `/console/workspace/create`.

**Comportement attendu après fix** :

```
Provision(input) {
  workspace = upsert workspaces(id=input.tenant_id, name=input.workspace_name)
  api_key_user = upsert users(email=`api${ts}@notifuse...`, type=api_key)
  upsert user_workspaces(api_key_user, workspace, role=member)

  // === Nouveau bloc obligatoire ===
  owner_user = upsert users(email=input.owner_email, type=user)
  upsert user_workspaces(owner_user, workspace, role=owner)
  // === Fin nouveau bloc ===

  return ProvisionResponse{..., owner_user_id: owner_user.id}
}
```

Idempotence requise : si appelé 2× avec mêmes inputs, pas de doublon dans `user_workspaces`.

### Livrable 2 — Nouvel endpoint `POST /api/tenants/attach-owner`

Auth : HMAC Hub (même middleware que les autres endpoints `/api/tenants/*`).

**Request** :
```json
{
  "tenant_id": "string (workspace_id)",
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

**Response 404** : workspace inexistant (renvoie `{"error":"workspace not found"}`).
**Response 422** : `owner_email` invalide (regex email).

**Comportement** :
- User n'existe pas → créer (`type: user`, sans password, sans email vérifié, métadonnées `{source: "hub-attach-owner"}`).
- User existe + déjà attaché avec le bon role → `already_attached: true, attached: false`.
- User existe + attaché avec role différent → upgrade au role demandé (`attached: true, already_attached: true`).
- **Additif uniquement** : on ne retire jamais un owner existant.

### Livrable 3 — Nouvel endpoint `GET /api/tenants/{id}/health`

Auth : HMAC Hub.

**Response 200** :
```json
{
  "tenant_id": "robertbrunon",
  "workspace_id": "robertbrunon",
  "status": "active",
  "owner_attached": true,
  "owner_email": "robert.brunon@veridian.site",
  "owner_user_id": "0cb49456-...",
  "api_key_valid": true,
  "magic_link_capable": true,
  "members_count": 2,
  "plan": "free",
  "checked_at": "2026-05-17T22:00:00Z"
}
```

`magic_link_capable: false` si :
- Pas d'owner humain (`type: user`) dans `user_workspaces`.
- API key tenant révoquée.
- Workspace soft-deleted.

**Response 404** : workspace inexistant.

Le Hub appelle ce endpoint en cron 1×/h pour stocker l'état observé dans une nouvelle table `hub_app.tenant_health_check`.

## Tests à ajouter (côté Notifuse)

### Tests unitaires `internal/service/veridian_service_test.go`

```go
// 1. Provision attache l'owner humain dans user_workspaces
func TestProvision_AttachesHumanOwner(t *testing.T) {
  // assert: userRepo.FindByEmail("alice@test") existe, type=user
  // assert: workspaceRepo.GetUserWorkspaces(user.ID) contient "ws-X" avec role=owner
}

// 2. Provision idempotent: 2x même input = pas de doublon
func TestProvision_IdempotentOwner(t *testing.T) { ... }

// 3. AttachOwner crée user si absent + attache
func TestAttachOwner_CreatesAndAttaches(t *testing.T) { ... }

// 4. AttachOwner idempotent
func TestAttachOwner_AlreadyAttached(t *testing.T) { ... }

// 5. AttachOwner upgrade role (admin → owner)
func TestAttachOwner_UpgradeRole(t *testing.T) { ... }

// 6. AttachOwner additif (ne retire pas l'ancien owner)
func TestAttachOwner_AdditiveOnly(t *testing.T) { ... }

// 7. Health renvoie magic_link_capable=false si pas d'owner humain
func TestHealth_NoHumanOwner(t *testing.T) { ... }

// 8. Health renvoie magic_link_capable=true sur workspace sain
func TestHealth_Healthy(t *testing.T) { ... }
```

### Test d'intégration `tests/integration_veridian_test.go`

**Scénario complet contractuel** (le scénario 1-8 du README intégration Hub) :

```go
func TestE2E_HubIntegrationContract(t *testing.T) {
  // 1. provision(tenant_id=T1, owner_email=alice@test, plan=freemium)
  //    → assert created=true, api_key non-null, owner_user_id non-null

  // 2. generateMagicLink(api_key, user_email=alice@test)
  //    → assert magic_link, auto_login_url non-null

  // 3. Décoder le JWT de auto_login_url manuellement
  //    → assert workspaces non-vide contient T1
  //    ↑ C'est CE point qui détecte le bug actuel.

  // 4. health(tenant_id=T1)
  //    → assert magic_link_capable=true, owner_attached=true, owner_email=alice@test

  // 5. suspend(tenant_id=T1, reason=test)
  //    → health → assert status=suspended

  // 6. resume(tenant_id=T1)
  //    → health → assert status=active

  // 7. attach-owner(tenant_id=T1, owner_email=bob@test)
  //    → already_attached=false, role=owner
  //    → health → members_count=3 (alice + bob + api_key)

  // 8. attach-owner(tenant_id=T1, owner_email=bob@test) [encore]
  //    → already_attached=true

  // 9. provision(tenant_id=T1, owner_email=alice@test) [encore]
  //    → created=false (idempotence)
}
```

**Ce test doit tourner en CI sur chaque PR Notifuse** (workflow GitHub Actions `notifuse-ci.yml`). Bloquant.

## Coordination avec le Hub

Quand les 3 livrables sont en prod Notifuse, **prévenir l'agent Hub** :

1. **Déplacer ce fichier** : `notifuse-veridian/todo/2026-05-17-provision-owner-attach.md` → `notifuse-veridian/todo/done/2026-05-17-provision-owner-attach.md`.
2. **Créer** `veridian-hub/todo/from-notifuse/2026-05-17-attach-owner-ready.md` avec le message :
   ```
   # Notifuse attach-owner READY (prod)

   - Provision fixé (commit <sha>)
   - POST /api/tenants/attach-owner exposé (HMAC)
   - GET /api/tenants/{id}/health exposé (HMAC)
   - Test e2e en CI passe

   Le Hub peut maintenant:
   1. Appeler attach-owner pour réparer les 11 tenants prod existants.
   2. Brancher le cron health 1×/h.
   ```
3. Robert (humain) prévient l'agent Hub via prompt.

## Migration data prod (à coordonner)

Une fois `attach-owner` en prod Notifuse, le Hub lancera un script `scripts/admin/repair-notifuse-owners.mjs` qui :

```js
for each tenant in hub_app.tenants where notifuse_workspace_slug not null:
  await callNotifuseAttachOwner(tenant.notifuse_workspace_slug, tenant.notifuse_user_email, "owner")
  await callNotifuseHealth(tenant.notifuse_workspace_slug)
  → assert owner_attached === true
```

11 tenants à réparer. ~1min total.

## Reproduction live du bug (2026-05-17, prod)

User loggué Hub = `robert.brunon@veridian.site`. Tenant `359b76d5-bab7-4773-a889-cf4cf0248869`. Workspace Notifuse `robertbrunon`.

1. Click "Open Notifuse" sur dashboard Hub.
2. Hub `POST /api/admin/notifuse/magic-link` → `200 OK` avec `autoLoginUrl` valide pointant vers `notifuse.app.veridian.site/veridian/auto-login?token=...`
3. Browser ouvre l'URL → Notifuse signe correctement le JWT (`auth_token` posé en localStorage) :
   ```json
   {
     "email": "robert.brunon@veridian.site",
     "user_id": "0cb49456-12cc-43f2-9a4e-423d16fcfb44",
     "type": "user",
     "exp": "2026-06-16T..."
   }
   ```
4. **MAIS** la console UI redirige vers `/console/workspace/create` au lieu d'ouvrir `robertbrunon`.

### SQL prod Notifuse qui prouve la cause

```sql
-- User 0cb49456-... existe mais n'est dans aucun workspace
SELECT u.email, u.type FROM users u WHERE u.id = '0cb49456-12cc-43f2-9a4e-423d16fcfb44';
-- → robert.brunon@veridian.site, user

SELECT count(*) FROM user_workspaces WHERE user_id = '0cb49456-12cc-43f2-9a4e-423d16fcfb44';
-- → 0   ← LE BUG

-- Le workspace robertbrunon a un owner mais c'est le mauvais user
SELECT u.email, uw.role FROM users u JOIN user_workspaces uw ON uw.user_id = u.id WHERE uw.workspace_id = 'robertbrunon';
-- → brunon5robert@gmail.com, owner
-- → api1775...@notifuse..., member
-- (PAS robert.brunon@veridian.site)
```

### Le pattern est systémique

```sql
-- Sur les 11 vrais workspaces prod (e2e exclus):
SELECT w.id,
       (SELECT u.email FROM user_workspaces uw JOIN users u ON u.id = uw.user_id
        WHERE uw.workspace_id = w.id AND u.type = 'user' AND uw.role = 'owner' LIMIT 1) AS human_owner
FROM workspaces w
WHERE w.id IN ('raprogripacu2843','guilhemjacquet1','guilhemjacquet','rbrunon','robinixbox',
               'ismailelmouaddab','zaleusseucroizi8925','antjacquet','darysisowath',
               'brunon5robert','robertbrunon');
```

**Résultat** : les 11 workspaces ont `brunon5robert@gmail.com` comme unique owner humain. Les vrais owners (côté Hub `tenants.notifuse_user_email`) ne sont attachés à aucun workspace.

→ `Provision` côté Notifuse n'attache jamais le `owner_email` envoyé par le Hub. Le premier user historique de l'instance (`brunon5robert@gmail.com`, créé en tout début 2026) a hérité de tous les workspaces par défaut.

## Code Hub envoie bien l'owner_email

Vérifié dans `veridian-hub/lib/notifuse/client.ts:60-66` :

```ts
async provisionWorkspace(input: ProvisionInput): Promise<ProvisionResponse> {
  return this.hmacRequest<ProvisionResponse>('POST', '/api/tenants/provision', {
    tenant_id: input.tenantId,
    owner_email: input.ownerEmail,   // ← envoyé correctement
    workspace_name: input.workspaceName,
    plan: input.plan,
  });
}
```

Le bug est donc **entièrement** côté `service.Provision()` Notifuse.

## Hors-scope explicite

- **Pas de transfer-owner** dans ce ticket (atomic remove + add). Endpoint `attach-owner` est additif uniquement. Le transfer pourra venir en v2.
- **Pas de cleanup automatique** des users orphelins (`0cb49456-...` & co restent en DB après ce fix). Décision à part.
- **Pas de migration des users `brunon5robert@gmail.com` owners par défaut** : ils peuvent rester comme co-owners pour le moment. Le vrai owner sera juste ajouté en plus.
