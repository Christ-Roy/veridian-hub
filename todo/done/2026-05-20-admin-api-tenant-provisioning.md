# [HUB] API admin pour provisioning manuel propre (anti-INSERT-SQL-cassé)

> **Type** : Outil interne admin Veridian
> **Sévérité** : 🔴 P1 — débloque le mode "service" sans risque corruption DB
> **Owner** : agent Hub
> **Créé** : 2026-05-20
> **Bloque** : `todo/2026-05-20-quick-win-avse-cms-card-fallback.md`
> **✅ PHASE 1 LIVRÉE** : 2026-05-20 (commit `a2a96f0`, smoke prod OK)
>
> **Réalisé** :
> - Migration Prisma `20260520160000_add_audit_log_table` (CREATE TABLE +
>   2 index, additive, appliquée manuellement staging + prod 2026-05-20)
> - Modèle `AuditLog` dans schema.prisma
> - `lib/admin/audit-log.ts` : writeAuditLog best-effort + resolveActor
> - `lib/admin/users.ts` : upsertHubUser idempotent (gère backfill
>   supabaseUserId pour users legacy)
> - `lib/admin/link-app.ts` : linkApp + unlinkApp, stratégie par app
>   (notifuse/prospection = colonnes dédiées ; cms/analytics = metadata)
> - `POST   /api/admin/users/create`        (auth + Zod + idempotent + audit)
> - `GET    /api/admin/users/[email]`       (state complet user + tenants)
> - `POST   /api/admin/tenants/link-app`    (404 si user inexistant,
>   idempotent via upsert, audit)
> - `DELETE /api/admin/tenants/unlink-app`  (soft unlink + audit)
> - 45 nouveaux tests vitest (445/445 vert)
> - Smoke prod : 3 routes admin → 401 sans auth (guards OK)
>
> **⏳ Phases 2-3 à découpler en tickets dédiés** :
> - Skill agent IA `~/.claude/skills/hub-admin/` qui appelle ces endpoints
> - Intégration côté skills `cms-provision` / `analytics-provision`
>   (remplacer les INSERT SQL bruts par des curl vers cette API)
> - POST /api/admin/users/migrate-to-discovery (après pattern discovery)
>
> **Migration prod (procédure utilisée 2026-05-20)** :
> ```bash
> # Container DB prod : compose-parse-multi-byte-feed-ywg73b-veridian-core-db-1
> scp prisma/migrations/20260520160000_add_audit_log_table/migration.sql \
>   prod-pub:/tmp/audit_log_migration.sql
> ssh prod-pub "docker cp /tmp/audit_log_migration.sql \
>   compose-parse-multi-byte-feed-ywg73b-veridian-core-db-1:/tmp/m.sql && \
>   docker exec compose-parse-multi-byte-feed-ywg73b-veridian-core-db-1 \
>   psql -U veridian -d veridian -f /tmp/m.sql"
> ```

## Contexte

Vision business Robert (2026-05-20) : **mode mi-service mi-SaaS**.
- Mode service : Robert provisionne manuellement un client via skills
  (`cms-provision`, `analytics-provision`, etc.) puis lie ce provisioning
  à un user Hub pour qu'il voie ses cards.
- Mode SaaS : user self-serve via le dashboard Hub.

Aujourd'hui le **mode service côté Hub passe par des INSERT SQL** (ce que
suggère le ticket quick-win AVSE). C'est **dangereux** :
- Pas de validation Zod → typos UUID, JSON malformé
- Pas de transaction atomique → user créé sans tenant si crash mi-chemin
- Pas d'idempotence → relance crée un doublon
- Pas d'audit log → impossible de tracer "qui a provisionné quoi quand"
- Pas de permission gating → tout admin DB peut tout faire

**Robert demande** : "j'aimerais que ce soit propre, possible de le faire
manuellement via API sans risque de corrompre la DB."

## Solution : endpoints admin authentifiés

### 1. Authentification

- Auth : middleware `requireAdmin()` côté serveur (vérifie `User.isPlatformAdmin = true`)
- OU : token statique `HUB_ADMIN_TOKEN` (header `X-Hub-Admin-Token`) pour
  agents IA / scripts. Stocké dans `~/credentials/.all-creds.env`.

### 2. Endpoints à livrer

#### `POST /api/admin/users/create` (idempotent)

Crée un user Hub sans attendre signup OAuth.

```json
// Request
{
  "email": "avse.monetique@gmail.com",
  "name": "Didier Bollard",
  "preprovisioned": true,
  "metadata": { "source": "skill-cms-provision", "client_name": "AVSE Monétique" }
}

// Response 200
{
  "user_id": "cuid...",
  "supabase_user_id": "uuid...",
  "email": "...",
  "created": true,
  "already_existed": false
}
```

Si user existe déjà : retourne `already_existed: true` (idempotent).

#### `POST /api/admin/tenants/link-app` (idempotent)

Lie un user Hub à un tenant existant côté app downstream (mode service).

```json
// Request
{
  "user_email": "avse.monetique@gmail.com",
  "app": "cms",                          // 'cms' | 'notifuse' | 'prospection' | 'analytics'
  "external_tenant_id": "1",             // id côté app
  "external_tenant_slug": "avse",
  "tenant_name": "AVSE Monétique",
  "plan": "complimentary",               // 'freemium' | 'starter' | 'pro' | 'enterprise' | 'complimentary'
  "fallback_url": "https://cms.veridian.site/admin",
  "magic_link_capable": false,
  "provisioning_source": "skill-cms-provision",
  "notes": "Provisionné manuellement le 2026-05-20"
}

// Response 200
{
  "tenant_id": "uuid",
  "user_id": "uuid",
  "metadata_path": "tenants.metadata.cms",  // pour audit/reproductibilité
  "created": true
}
```

Comportement :
- Si le user Hub n'existe pas → 404 (l'appelant doit d'abord `POST /api/admin/users/create`)
- Si déjà lié → update les champs (idempotent)
- Stocke dans `hub_app.tenants` :
  - Pour Notifuse / Prospection : utilise les colonnes dédiées existantes
    (`notifuse_*`, `prospection_*`)
  - Pour CMS / Analytics : stocke dans `metadata.cms` / `metadata.analytics`
    (jsonb) — sans migration Prisma immédiate
- Écrit une row `hub_app.audit_log` : `{action: 'admin.tenant.link', actor, target_email, payload}`

#### `DELETE /api/admin/tenants/unlink-app`

Inverse de `link-app`. Soft-delete (garde la trace dans `audit_log`).

#### `GET /api/admin/users/:email` (lecture)

Retourne le state complet user + tenants côté Hub. Utile pour vérifier
l'idempotence d'un script ou debug.

#### `POST /api/admin/users/migrate-to-discovery` (à câbler après le pattern discovery)

Pour les users provisionnés en metadata avant le pattern discovery,
migration douce → invalide le cache et appelle les apps en discovery direct.

### 3. Migration Prisma minimale

Ajouter une table `hub_app.audit_log` :

```prisma
model AuditLog {
  id          String   @id @default(cuid())
  action      String   // 'admin.user.create', 'admin.tenant.link', ...
  actor       String   // 'admin:robert.brunon@veridian.site' ou 'token:HUB_ADMIN_TOKEN'
  targetType  String?  @map("target_type") // 'user' | 'tenant'
  targetId    String?  @map("target_id")
  payload     Json?
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([action, createdAt])
  @@index([targetId])
  @@map("audit_log")
  @@schema("hub_app")
}
```

### 4. Tests (mode Nuclear bloquant)

Pour chaque endpoint :
- HMAC/admin token valide → 200
- Token invalide → 401
- Payload Zod-invalide → 400 avec détails
- Idempotence : appel 1 = create, appel 2 = no-op
- Audit log écrit
- Tests intégration DB éphémère (testcontainers)

### 5. SDK / skill agent

Une fois l'API en place, créer un **skill** ou helper :
- `~/.claude/skills/hub-admin/SKILL.md` qui documente les endpoints
- OU helpers shell : `scripts/admin/link-cms.sh <email> <cms_slug>`

→ ainsi les autres skills (`cms-provision`, `analytics-provision`) peuvent
**appeler ces endpoints au lieu de faire des INSERT SQL**.

## Effort estimé

- 0.5j : migration Prisma + table `audit_log`
- 2-3j : 4 endpoints + middleware admin auth + tests
- 1j : helpers shell + doc dans CONTRAT-HUB.md §10 "API admin"

**Total** : ~4-5j pour livraison clean

## Étapes recommandées

1. **Phase 1** : migration `audit_log` + endpoint `POST /api/admin/tenants/link-app` (le plus urgent)
2. **Phase 2** : `POST /api/admin/users/create` + `GET /api/admin/users/:email`
3. **Phase 3** : intégration côté skills `cms-provision` (l'agent IA appelle l'API au lieu de SQL)
4. **Phase 4** : intégration côté pattern discovery (cron sync hebdo)

## Workflow type post-livraison

```bash
# Robert provisionne AVSE côté CMS via skill manuel
$ /cms-provision avse-monetique

# Le skill cms-provision appelle automatiquement le Hub admin API :
curl -X POST https://app.veridian.site/api/admin/users/create \
  -H "X-Hub-Admin-Token: $HUB_ADMIN_TOKEN" \
  -d '{"email":"avse.monetique@gmail.com","name":"Didier Bollard"}'

curl -X POST https://app.veridian.site/api/admin/tenants/link-app \
  -H "X-Hub-Admin-Token: $HUB_ADMIN_TOKEN" \
  -d '{"user_email":"avse.monetique@gmail.com","app":"cms","external_tenant_id":"1","external_tenant_slug":"avse","tenant_name":"AVSE Monétique","plan":"complimentary","fallback_url":"https://cms.veridian.site/admin"}'

# AVSE se logge sur app.veridian.site via Google
# → user Hub déjà existant → link auto (allowDangerousEmailAccountLinking)
# → dashboard affiche la card CMS via metadata.cms
```

**Zero SQL brut. Zero risque corruption. Audit complet.**

## Référence

- `todo/2026-05-20-hub-discovery-by-email-pattern.md` (vision long terme)
- `todo/2026-05-20-quick-win-avse-cms-card-fallback.md` (ancien plan qui passait par SQL — à mettre à jour pour passer par cette API)
- `CONTRAT-HUB.md` §3 (patterns auth Hub)
- Pattern audit log : équivalent de ce que fait Stripe Dashboard Events
