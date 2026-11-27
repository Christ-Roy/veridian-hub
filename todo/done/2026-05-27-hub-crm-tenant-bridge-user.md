# [HUB] Politique bridge Hub.User ↔ crm_tenants à la création

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Audit `/tmp/audit-crm-needs-2026-05-27.md` §D.1 (manque mineur identifié)
> - Complète `todo/2026-05-27-route-admin-create-crm-tenant.md` (la route admin assume `hub_app.users(id)` existe)

## Contexte

Le ticket `route-admin-create-crm-tenant.md` définit le schéma :

```sql
CREATE TABLE hub_app.crm_tenants (
  ...
  user_id UUID NOT NULL REFERENCES hub_app.users(id) ON DELETE CASCADE,
  ...
);
```

Et la route admin `POST /api/admin/crm/create-tenant` prend `{ email,
workspaceName }`. **Mais** : que se passe-t-il si l'email passé n'est pas
encore connu côté `hub_app.users` ? Aujourd'hui le ticket n'explicite pas
ce cas → l'INSERT explose sur FK violation et le tenant Twenty est créé
orphelin (la migration GraphQL Twenty est faite, mais le Hub ne peut pas
le tracker).

Ce ticket grave la politique : **créer auto un Hub.User si email
inconnu, sans déclencher de signup flow**.

## Action attendue

### 1. Helper `lib/admin/users.ts` étendu

Ajouter (ou réutiliser si existant) :

```typescript
export async function getOrCreateHubUserForAdmin(email: string): Promise<{
  user: User;
  created: boolean;
}> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { user: existing, created: false };

  const hubUser = await prisma.user.create({
    data: {
      email,
      emailVerified: null,         // pas vérifié, l'user vérifiera s'il se logge
      supabaseUserId: randomUUID(),// requis cf reference_oauth_supabase_user_id_bridge
      // pas de password — l'user devra magic link signup s'il veut se logger via Hub
      // pas de workspace auto — sera créé si l'user fait son premier login Hub
    },
  });

  await writeAuditLog('admin.users.create-shadow', {
    email,
    reason: 'crm_tenant_provisioning',
    user_id: hubUser.id,
  });

  return { user: hubUser, created: true };
}
```

### 2. Branchement dans `POST /api/admin/crm/create-tenant`

Avant de créer le `crm_tenant`, appeler `getOrCreateHubUserForAdmin(email)`
pour garantir que le FK est valide. La response 201 mentionne :

```json
{
  "tenantId": "...",
  "userId": "...",
  "userWasCreated": true|false,
  ...
}
```

Si `userWasCreated: true`, Robert sait que l'user n'a pas de session Hub
active et doit recevoir un magic link signup Hub séparément s'il veut
gérer son billing.

### 3. Communication user

Quand `userWasCreated: true`, **ne pas envoyer auto** un mail signup Hub
(Robert peut vouloir provisionner sans avertir le client tout de suite,
ex : démo offerte). Mais retourner dans la response un `signupMagicLink`
préformaté que Robert peut copier-coller s'il veut :

```json
{
  "userOnboarding": {
    "userWasCreated": true,
    "hubSignupMagicLink": "https://app.veridian.site/signup?email=<encoded>&from=crm-onboarding"
  }
}
```

(Pas de génération de token magic réel automatique — c'est juste un lien
deeplink vers le signup classique préfilled.)

### 4. Cleanup ON DELETE CASCADE

Le schéma actuel a `ON DELETE CASCADE` côté FK. Vérifier explicitement :
- Suppression Hub.User → suppression auto du `crm_tenant` row
- ⚠️ Mais le tenant Twenty (DB côté Twenty) **reste** — c'est conforme à
  la décision standalone (Twenty n'est jamais piloté en delete par le Hub).
  Documenter dans `docs/CRM-INTEGRATION.md` : "ON DELETE Hub.User n'efface
  pas le tenant Twenty. Pour purge totale, voir le runbook
  `runbooks/crm/delete-tenant.md` (vague 4)."

### 5. Migration des tenants existants

Le seul tenant CRM existant 2026-05-27 = Robert
(robert.brunon@veridian.site). Son `User.id` existe déjà dans
`hub_app.users` → aucun shadow user à créer rétroactivement. Documenter
cette vérification dans le PR description.

## Tests / DoD

- [ ] Test unitaire `getOrCreateHubUserForAdmin` :
  - Email existant → return user existant, `created: false`
  - Email nouveau → INSERT, return user, `created: true`, `supabaseUserId` set
  - Email nouveau 2 fois → UNIQUE constraint (déjà géré au 2e call par le findUnique)
- [ ] Test route `POST /api/admin/crm/create-tenant` :
  - Email nouveau → tenant créé + shadow user créé + response contient `userWasCreated: true`
  - Email connu → tenant créé + pas de nouvelle user + response `userWasCreated: false`
- [ ] Audit log `admin.users.create-shadow` écrit avec reason
- [ ] Doc `docs/CRM-INTEGRATION.md` section "Shadow users" expliquant
  pourquoi un user peut exister dans `hub_app.users` sans avoir jamais
  signup via le flow Hub

## Non-objectifs

- ❌ Envoyer auto un mail "Bienvenue Hub" au shadow user (Robert décide quand)
- ❌ Créer auto un Hub.Workspace pour le shadow user (lazy à la 1ère session)
- ❌ Forcer une vérification email préalable (pas de friction sur provisioning admin)
- ❌ UI admin pour lister les shadow users (vague 4+)
