# Veridian SaaS — Standards cross-app

> **Ce document est la source de vérité des patterns SaaS que toutes les apps Veridian
> doivent respecter.** Toute nouvelle feature doit cocher la checklist en bas. Le lead
> du sprint valide avant merge.

Audience : agents Claude, dev humains, reviewers. Toute app du monorepo (Hub,
Prospection, Notifuse fork, Analytics, apps futures) s'y conforme. Les écarts
existants sont de la dette technique et doivent être tracés dans `todo/TODO-LIVE.md`.

---

## 0. Pourquoi ces standards

Sans ces règles, chaque app réinvente son soft-delete, son paywall, ses rôles, son
contrat de provisioning. On se retrouve avec 3 implémentations divergentes, 3 bugs
différents, et aucune cohésion entre apps pour l'utilisateur final. Le but :

- **Une app Veridian est prévisible** : mêmes rôles, même flow invitation, même
  contrat HTTP vers le Hub.
- **On peut ajouter une app OSS en une session** : forker, cocher la checklist,
  déployer. Pas de questions architecturales ouvertes.
- **On peut retirer une app sans casser le reste** : indépendance d'auth, de DB,
  de webhook Stripe. Chaque app est autonome.

---

## 1. Persistance et multitenance

### 1.1 Postgres cible

- **Toute nouvelle app ou feature écrit sur `veridian-core-db`** (voir
  `infra/docker-compose.yml` service `veridian-core-db`, base `veridian`).
- **Plus jamais sur Supabase PG** sauf tables legacy déjà présentes (Prospection
  tenants/profiles, auth Supabase). C'est dette acceptée à court terme, pas un
  nouveau pattern.
- **Exceptions de fait** :
  - Prospection garde sa PG dédiée (historique 996k entreprises, ne bouge pas).
  - Notifuse garde la sienne (boîte noire upstream, on minimise le diff).
  - Les apps futures (Analytics, Hub extensions) écrivent sur `veridian-core-db`.

### 1.2 Isolation par schema Prisma

Un schema Postgres par app sur `veridian-core-db` :

- `hub_app` — tables Hub (tenants, subscriptions, audit_log, invitations Hub)
- `analytics` — tables Analytics (sites, pageviews, form_submissions, sip_calls)
- `<futur_app>` — …

Prisma support multi-schema :

```prisma
// hub/prisma/schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["hub_app"]
}

model Tenant {
  id        String   @id @default(uuid()) @db.Uuid
  // ...
  @@schema("hub_app")
}
```

Aucune app ne lit ou écrit dans le schema d'une autre app. Pas de foreign keys
cross-schema. La communication inter-apps passe exclusivement par HTTP (voir §7).

### 1.3 Colonne `tenant_id` obligatoire

Toute table qui porte des données d'un tenant (leads, invitations, sessions
utilisateur, submissions, calls, …) a :

- Colonne `tenant_id UUID NOT NULL`
- Index sur `tenant_id` (ou index composite `(tenant_id, autre_colonne)` si
  query-dependent)
- Filtrage systématique `WHERE tenant_id = $1` dans les queries — jamais de
  query "globale" côté app

Les tables de type catalogue partagé (ex : `entreprises` SIREN en Prospection)
sont exemptées — documenter explicitement le fait qu'elles sont cross-tenant.

### 1.4 Soft deletion

- Colonne `deleted_at TIMESTAMPTZ NULL` sur toutes les tables tenant-scoped.
- Helper Prisma middleware recommandé pour filtrer automatiquement à la lecture :

```ts
// lib/prisma.ts
prisma.$use(async (params, next) => {
  // À l'écriture : convertir delete → update set deleted_at
  if (params.action === 'delete') {
    params.action = 'update';
    params.args.data = { deleted_at: new Date() };
  }
  // À la lecture : ajouter le filtre deleted_at IS NULL
  if (params.action === 'findMany' || params.action === 'findFirst') {
    params.args.where = { ...params.args.where, deleted_at: null };
  }
  return next(params);
});
```

- **Purge définitive après 30 jours** via un cron Dokploy (Schedule Jobs), pas de
  cron système ad hoc. Script purge SQL simple :

```sql
DELETE FROM <table> WHERE deleted_at < now() - interval '30 days';
```

- Le cron est documenté dans le `docker-compose` de l'app et tracé dans
  `todo/apps/<app>/TODO.md`.

### 1.5 Modèle Prisma de référence (soft delete + tenant)

```prisma
model Invoice {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @map("tenant_id") @db.Uuid
  amountCts  Int       @map("amount_cts")
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime  @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz

  @@index([tenantId])
  @@index([tenantId, deletedAt])
  @@map("invoices")
  @@schema("hub_app")
}
```

---

## 2. Auth et sessions

### 2.1 Indépendance d'auth

**Chaque app a son propre auth.** Si l'auth Hub tombe, Prospection continue de
fonctionner. C'est un principe non-négociable de `.claude/rules/architecture.md`.

- Pas de SSO Veridian cross-app au stade actuel (chantier douloureux, pas dans P1).
- Le Hub délivre des credentials à chaque app via `POST /api/tenants/provision`
  (voir §7). L'app stocke les credentials localement et gère ses sessions.
- L'invitation cross-app (inviter un membre dans Prospection depuis le Hub)
  passe par un token HMAC signé du Hub → l'app crée l'utilisateur localement.

### 2.2 Stack recommandée — Next.js apps

- **Auth.js v5** (credentials + Google OAuth) pour les apps Next.js nouvelles.
- **Password hash** : bcrypt 12 rounds ou argon2id.
- **Session cookies** 3 mois par défaut :

```ts
// auth.config.ts
export const authConfig = {
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24 * 90, // 90 jours
  },
  cookies: {
    sessionToken: {
      name: '__Secure-veridian-session',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
      },
    },
  },
};
```

- **2FA email opt-in** (pas obligatoire) — code 6 chiffres envoyé par mail,
  expire 10min. Implémenté dans le Hub en P1.4, à répliquer dans les autres apps
  au besoin. Flag `two_factor_enabled` sur le user.

### 2.3 Exceptions

- **Prospection** utilise encore Supabase Auth → dette P2 (chantier douloureux).
  Ne pas étendre ce pattern aux nouvelles apps.
- **Twenty** a son propre auth OSS → on le garde, on l'alimente via provisioning
  API.
- **Notifuse** a son propre auth OSS → idem.

---

## 3. Rôles workspace

**Les 4 rôles Veridian, identiques partout** (calque Twenty) :

| Rôle     | Permissions                                                          |
|----------|----------------------------------------------------------------------|
| `owner`  | Full access. Delete workspace, transfert d'ownership, billing        |
| `admin`  | Full sauf delete workspace et changer l'owner                        |
| `member` | CRUD sur les ressources qu'il possède, read-only sur les autres      |
| `viewer` | Read-only sur tout le workspace                                      |

### 3.1 Type TypeScript partagé

Chaque app définit ces rôles dans `src/lib/auth/roles.ts` :

```ts
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export type WorkspaceAction =
  | 'workspace.delete'
  | 'workspace.transfer'
  | 'member.invite'
  | 'member.remove'
  | 'member.change_role'
  | 'billing.manage'
  | 'resource.create'
  | 'resource.update.own'
  | 'resource.update.any'
  | 'resource.delete.own'
  | 'resource.delete.any'
  | 'resource.read';

const PERMISSIONS: Record<WorkspaceAction, WorkspaceRole> = {
  'workspace.delete':       'owner',
  'workspace.transfer':     'owner',
  'billing.manage':         'owner',
  'member.invite':          'admin',
  'member.remove':          'admin',
  'member.change_role':     'admin',
  'resource.update.any':    'admin',
  'resource.delete.any':    'admin',
  'resource.create':        'member',
  'resource.update.own':    'member',
  'resource.delete.own':    'member',
  'resource.read':          'viewer',
};

export function canPerform(role: WorkspaceRole, action: WorkspaceAction): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[PERMISSIONS[action]];
}
```

### 3.2 Middleware de filtrage

Toutes les queries sont scopées par `workspace_id` et le rôle de l'acteur.
Pattern : helper `requireRole(action)` dans chaque route API qui rejette 403
si `canPerform(userRole, action) === false`.

---

## 4. Invitations

Flow standard invitation cross-app :

1. Un `owner`/`admin` invite par email via le Hub ou l'app elle-même.
2. Une row `Invitation` est créée avec `(workspace_id, email, role, token,
   expires_at, accepted_at)`. `token` = random 32 bytes hex. `expires_at` = now
   + 7 jours.
3. Un email est envoyé via Notifuse (prod) ou Brevo (transition), template
   uniforme "Vous êtes invité chez Veridian".
4. Le destinataire clique sur le lien → page `/invite/[token]` (standardisée) :
   - Si token invalide/expiré/déjà utilisé → écran d'erreur + CTA contact support
   - Si valide et non connecté → signup ou login, puis acceptation automatique
   - Si valide et connecté → acceptation immédiate, redirection dashboard
5. À l'acceptation : row `accepted_at = now()`, création du `workspace_member`
   avec le bon rôle.
6. Audit log : `member.invited` à la création, `member.joined` à l'acceptation.

### 4.1 Modèle Prisma de référence

```prisma
model Invitation {
  id           String    @id @default(uuid()) @db.Uuid
  workspaceId  String    @map("workspace_id") @db.Uuid
  email        String
  role         String    // WorkspaceRole
  token        String    @unique
  invitedBy    String    @map("invited_by") @db.Uuid
  expiresAt    DateTime  @default(dbgenerated("(now() + interval '7 days')")) @map("expires_at") @db.Timestamptz
  acceptedAt   DateTime? @map("accepted_at") @db.Timestamptz
  revokedAt   DateTime? @map("revoked_at") @db.Timestamptz
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@index([workspaceId])
  @@index([email])
  @@index([token])
  @@map("invitations")
}
```

---

## 5. Stripe billing

### 5.1 Source de vérité

**Stripe est la source de vérité.** Pas de table maison `plans` qu'on maintient
à la main. L'état d'un tenant (plan, limites, `active`/`suspended`/`canceled`)
est piloté par Stripe via webhooks.

### 5.2 Webhooks locaux par app

- **Chaque app payante a son propre webhook** `POST /api/webhooks/stripe`, pas
  de routing centralisé via le Hub.
- Le Hub a aussi son webhook pour le billing de base (signup, plan initial).
- Vérification signature Stripe obligatoire (`stripe.webhooks.constructEvent`).
- Idempotent : on dédoublonne sur `event.id` (table `stripe_events_processed`).
- Événements minimum à gérer :
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`

### 5.3 Config limites par plan

Config centralisée dans l'app (pas en DB, pas en env var dispersée) :

```ts
// hub/config/billing.config.ts
export const PLAN_LIMITS = {
  free: {
    leads_total: 300,
    members: 1,
    workspaces: 1,
  },
  pro: {
    leads_total: 5000,
    members: 5,
    workspaces: 3,
  },
  enterprise: {
    leads_total: -1, // unlimited
    members: -1,
    workspaces: -1,
  },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
```

Les limites sont enforced dans les routes API via un helper `enforceLimit(plan,
'leads_total', currentCount)`.

### 5.4 Paywall middleware

Un middleware bloque les routes payantes si `plan_status !== 'active'` ou si
`trial_ends_at` est expiré.

```ts
// lib/paywall.ts
export async function requireActivePlan(tenantId: string): Promise<
  { ok: true; plan: Plan } | { ok: false; reason: 'trial_expired' | 'suspended' | 'canceled' }
> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, planStatus: true, trialEndsAt: true },
  });
  if (!t) return { ok: false, reason: 'canceled' };
  if (t.planStatus === 'suspended') return { ok: false, reason: 'suspended' };
  if (t.planStatus === 'canceled')  return { ok: false, reason: 'canceled' };
  if (t.plan === 'free' && t.trialEndsAt && t.trialEndsAt < new Date()) {
    return { ok: false, reason: 'trial_expired' };
  }
  return { ok: true, plan: t.plan };
}
```

- Trial freemium par défaut 7 jours (override par plan Stripe si besoin).
- En cas de `ok: false`, l'app retourne 402 Payment Required sur les endpoints
  payants et affiche un paywall UI sur les pages protégées.

---

## 6. Provisioning API (contrat standard inter-apps)

**Toute app SaaS Veridian expose ces endpoints** pour que le Hub puisse la
piloter. Pas d'exception. C'est le contrat d'intégration.

| Méthode + Path                          | Body / Query                                  | Réponse                                            |
|-----------------------------------------|-----------------------------------------------|----------------------------------------------------|
| `POST /api/tenants/provision`           | `{ tenant_id, owner_email, plan }`            | `{ tenant_id, api_key, login_url, plan, created }` |
| `POST /api/tenants/update-plan`         | `{ tenant_id, plan }`                         | `{ tenant_id, plan, applied_at }`                  |
| `POST /api/tenants/suspend`             | `{ tenant_id, reason }`                       | `{ tenant_id, suspended_at }`                      |
| `POST /api/tenants/resume`              | `{ tenant_id }`                               | `{ tenant_id, resumed_at }`                        |
| `DELETE /api/tenants/:id`               | —                                             | `{ tenant_id, deleted_at }`                        |
| `GET  /api/tenants/:id/status`          | —                                             | `{ status, plan, usage: {...}, limits: {...} }`    |

- **Soft delete** sur `DELETE` → `deleted_at` + purge définitive 30j via cron.
- **Resume** réactive un tenant suspendu (ex : paiement qui repasse).
- **`GET status`** est utilisé par le Hub pour afficher l'usage temps réel dans
  le dashboard (ex : "245/300 leads utilisés").

### 6.1 Authentification HMAC

Toutes les requêtes inter-apps sont signées HMAC-SHA256 avec un secret partagé
`HUB_API_SECRET`. Header obligatoire : `X-Veridian-Hub-Signature`.

La signature couvre `${timestamp}.${rawBody}`. Le timestamp limite le replay
(drift max 5 min). Le body brut (pas parsé) est canonique — important pour
reproduire côté receveur.

**Côté Hub (émission)** :

```ts
// hub/lib/http/sign.ts
import { createHmac } from 'crypto';

export function signRequest(body: string, secret: string): {
  timestamp: string;
  signature: string;
} {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { timestamp, signature };
}

// Usage :
const body = JSON.stringify({ tenant_id, owner_email, plan });
const { timestamp, signature } = signRequest(body, process.env.HUB_API_SECRET!);
await fetch('https://prospection.app.veridian.site/api/tenants/provision', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Veridian-Timestamp': timestamp,
    'X-Veridian-Hub-Signature': signature,
  },
  body,
});
```

**Côté app (vérification)** :

```ts
// lib/http/verify-hub.ts
import { createHmac, timingSafeEqual } from 'crypto';

const MAX_DRIFT_MS = 5 * 60 * 1000;

export function verifyHubSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_DRIFT_MS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
```

- **Rate limit** : 10 req/min par IP par endpoint (mémoire suffit, pas besoin de
  Redis à ce stade).
- **Erreurs standards** : `401` signature invalide, `429` rate limit, `400`
  body malformé, `404` tenant inconnu, `409` conflit (déjà provisionné).

---

## 7. Audit log

### 7.1 Table `audit_log`

Chaque app a sa propre table `audit_log` dans son schema :

```prisma
model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String?  @map("tenant_id") @db.Uuid
  actorId     String?  @map("actor_id") @db.Uuid    // null = système/HMAC
  actorType   String   @map("actor_type")           // 'user' | 'hub' | 'stripe' | 'system'
  action      String                                // 'workspace.delete', 'plan.changed', ...
  targetType  String?  @map("target_type")          // 'workspace', 'member', 'tenant', ...
  targetId    String?  @map("target_id")
  metadata    Json?                                 // contexte libre (old/new values, reason, ip, ...)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([actorId])
  @@index([action])
  @@map("audit_log")
}
```

- **Pas de soft delete** : le log est immutable et read-only.
- **Rétention minimum 365 jours**. Purge au-delà via cron Dokploy (optionnel,
  storage est cheap, garder autant que possible).

### 7.2 Actions à logger obligatoirement

Toute action "sensible" est loggée. Liste minimale :

- `workspace.created`, `workspace.deleted`, `workspace.transferred`
- `member.invited`, `member.joined`, `member.role_changed`, `member.removed`
- `plan.changed`, `billing.subscription_updated`
- `tenant.provisioned`, `tenant.suspended`, `tenant.resumed`, `tenant.deleted`
- `admin.impersonate` (quand un staff Veridian se connecte en tant qu'un client)
- `auth.failed_login` (plus de 3 fois d'affilée sur un compte)

### 7.3 Helper `logAudit`

Chaque app a un helper `lib/audit.ts` :

```ts
// lib/audit.ts
import { prisma } from './prisma';

type LogAuditArgs = {
  tenantId?: string;
  actorId?: string;
  actorType: 'user' | 'hub' | 'stripe' | 'system';
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

export async function logAudit(args: LogAuditArgs): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: args.tenantId,
        actorId: args.actorId,
        actorType: args.actorType,
        action: args.action,
        targetType: args.targetType,
        targetId: args.targetId,
        metadata: (args.metadata ?? {}) as never,
      },
    });
  } catch (err) {
    // Ne jamais casser le flow métier à cause d'un log raté
    console.error('[audit] log failed', err);
  }
}
```

---

## 8. Health check

`GET /api/health` retourne le format standard :

```ts
type HealthResponse = {
  status: 'ok' | 'degraded' | 'down';
  version: string;                // app version from package.json
  db: 'ok' | 'ko';
  dependencies: Record<string, 'ok' | 'ko' | 'skipped'>; // stripe, notifuse, hub, ...
  timestamp: string;              // ISO8601
};
```

Règles :

- **Timeout total 5s max**. Chaque sous-check a son propre timeout (ex : 2s DB,
  2s Stripe). Si un check traîne, marquer `ko` et continuer.
- **Code HTTP** :
  - `200` si `status === 'ok'` ou `'degraded'`
  - `503` si `status === 'down'` (=  DB down, rien ne peut fonctionner)
- **`degraded`** = DB ok mais au moins une dépendance externe `ko` (ex : Stripe
  API injoignable). L'app continue à servir les routes qui n'en dépendent pas.
- **Utilisé par** Dokploy health check (container healthcheck) et le rollback
  auto CI (si health fail post-deploy → rollback image précédente).

### 8.1 Exemple de référence

```ts
// app/api/health/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import pkg from '../../../../package.json';

const TIMEOUT_MS = 2000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function GET() {
  const dbResult = await withTimeout(
    prisma.$queryRaw`SELECT 1 as ok`,
    TIMEOUT_MS,
  );
  const db: 'ok' | 'ko' = dbResult ? 'ok' : 'ko';

  // Dépendances externes (stub, à adapter par app)
  const dependencies: Record<string, 'ok' | 'ko' | 'skipped'> = {};

  let status: 'ok' | 'degraded' | 'down' = 'ok';
  if (db === 'ko') status = 'down';
  else if (Object.values(dependencies).some((v) => v === 'ko')) status = 'degraded';

  const body = {
    status,
    version: pkg.version,
    db,
    dependencies,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: status === 'down' ? 503 : 200 });
}
```

---

## 9. CI/CD — Tests robustes et flow staging → prod → rollback

**Règle opposable** : toute app Veridian doit avoir une CI qui **teste réellement**
le scénario complet d'un utilisateur, avant ET après deploy prod. Si un test prod
échoue, rollback automatique vers l'image précédente en moins de 30 secondes.

### Flow cible (identique sur toutes les apps)

```
push main
  → job test       (unit + build + lint, cloud ubuntu-latest)
  → job docker     (build image, push GHCR, self-hosted runner)
  → job deploy-staging (Dokploy redeploy stack staging)
  → job e2e-staging (Playwright navigateur, scénario complet, BLOQUANT)
  → job deploy-prod (Dokploy redeploy stack prod — uniquement si e2e-staging vert)
  → job e2e-prod (Playwright navigateur, scénario complet sur URL prod, BLOQUANT)
  → job rollback   (auto si e2e-prod fail : retag :rollback → :latest + redeploy)
```

Temps cible total du push à prod validée : **~10 min**.

### Tests e2e obligatoires (navigateur headless, Playwright)

Chaque app doit avoir au minimum ces scénarios dans `app/e2e/` :

1. **Health check** : GET `/api/health` retourne 200 avec format standard §8
2. **Login flow** : page login → credentials → redirect vers dashboard
3. **Protected route** : accès anonyme à une route authentifiée → redirect login
4. **Logout flow** : depuis dashboard → logout → redirect login
5. **Scenario métier critique** : au moins 1 action métier clé de l'app (invite
   membre pour Hub, ajout lead pour Prospection, etc.)

Les specs tournent en 3 browsers (chromium, firefox, webkit) en parallèle, mais
seul chromium est bloquant (firefox/webkit en warning).

### Distinction e2e-staging vs e2e-prod

- **e2e-staging** : peut utiliser des comptes de test, des données mockées,
  Stripe mode test. Attendue entre 1-3 minutes. Bloquant avant deploy prod.
- **e2e-prod** : **login-only**, pas de signup (rate-limit), avec un compte
  de test stable (`qa@veridian.site`). Scenarios read-only ou sur données de
  test isolées (prefix `test-ci-` + run_id). **Pas de création de data prod
  qui pourrait polluer**. Attendue < 2 minutes.

### Rollback automatique

Si `e2e-prod` fail après un deploy prod, le job `rollback` :
1. Tag l'image actuelle `:broken-<sha>` pour debug
2. Retag `:rollback` → `:latest` sur GHCR
3. Redeploy la stack prod via Dokploy API
4. Post-check health prod `/api/health`
5. Notification Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)

L'image `:rollback` est toujours maintenue à jour par le workflow docker :
à chaque nouveau build, l'ancienne `:latest` est retaguée `:rollback` avant
d'être écrasée.

### Environnement staging = mini-réplique prod

Le staging **n'est pas un mini-prod**. C'est juste un environnement où on
peut casser sans impact client. Il doit tourner sur la **même version de
code** que la prochaine prod, avec les **mêmes env vars** (sauf secrets
distincts), et la **même stack Dokploy** (même image, même compose). Si
le staging passe vert, la prod doit passer vert — sinon la CI a un trou.

### Référence existante

`prospection-ci.yml` implémente déjà ce flow complet (cf. fichier dans
`.github/workflows/`). Hub et Analytics doivent s'aligner dessus. Toute
nouvelle app se crée avec ce flow directement — pas de raccourci "on
verra les tests plus tard".

---

## 10. Workflow déploiement & Dokploy

**Règle absolue** : l'infra Veridian staging + prod est pilotée par **Dokploy**.
Les fichiers `infra/docker-compose.*.yml` du repo sont la **trace versionnée**
(source de vérité en code, reviews Git, historique) mais ne sont **PAS** appliqués
directement sur les serveurs. La source d'exécution c'est Dokploy.

Cette règle est opposable lors des reviews. Toute app/service Veridian déployé
suit ce workflow — pas d'exception. C'est déjà documenté dans `infra/CLAUDE.md`
(section "Workflow deploiement") ; on le reprend ici pour en faire une règle
standard du SaaS.

### 9.1 Workflow obligatoire pour toute modif d'infra

1. **Éditer le compose en local** (`infra/docker-compose.*.yml`)
2. **Valider le YAML** : `docker compose -f infra/docker-compose.<env>.yml config`
3. **Commit + push** (trace versionnée, code review)
4. **Ouvrir Dokploy** → stack concernée → reporter la modif :
   - Coller le YAML mis à jour dans l'éditeur Dokploy
   - Configurer / mettre à jour les secrets dans l'UI Dokploy
5. **Déployer depuis Dokploy** (bouton Deploy, pas de SSH)
6. **Vérifier** : logs Dokploy + health check `/api/health` (voir §8) + alertes
   monitoring (`/opt/veridian/monitoring/`)

### 9.2 Interdits absolus

- **`docker compose up` direct en SSH sur le VPS** → court-circuite Dokploy et
  désynchronise son état. Interdit, même pour un "petit test rapide".
- **Cron système ad hoc** (`crontab -e`, `/etc/cron.d/...`) → toujours passer
  par **Dokploy Schedule Jobs**. Cela inclut les purges soft delete 30j (§1.4).
- **Secrets en clair dans un compose commité** → interpolation `${VAR_NAME}`
  uniquement, valeurs dans l'UI Dokploy + miroir local dans
  `~/credentials/.all-creds.env`.
- **Modifier la prod Dokploy sans accord explicite de Robert** (règle racine
  `.claude/rules/git-workflow.md` et `CLAUDE.md`).

### 9.3 Cas particulier : nouveau service / nouvelle app

Quand on ajoute une app au monorepo (fork Notifuse, Analytics, etc.) :

1. Créer `<app>/Dockerfile` et le bloc compose correspondant (dans
   `infra/docker-compose.*.yml` ou un fichier dédié).
2. Commit + push de la trace versionnée.
3. Créer la stack correspondante dans Dokploy (UI), coller le YAML, configurer
   les secrets.
4. Ajouter le health check au compose (voir §8) pour permettre le rollback auto CI.
5. Ajouter l'app au monitoring (`/opt/veridian/monitoring/config.json` côté VPS).

---

## 11. Checklist d'audit SaaS

**À cocher pour toute nouvelle app ou toute feature majeure avant merge.**
Le lead du sprint valide.

### Persistance
- [ ] Toutes les tables tenant-scoped ont `tenant_id UUID NOT NULL` + index
- [ ] Toutes les tables tenant-scoped ont `deleted_at TIMESTAMPTZ NULL`
- [ ] Un schema Prisma dédié à l'app (pas de mélange cross-app)
- [ ] Les nouvelles tables écrivent sur `veridian-core-db` (ou documenté pourquoi non)
- [ ] Purge cron 30j déclarée dans Dokploy Schedule (ou trackée dans TODO)

### Auth
- [ ] Chaque app a son propre mécanisme d'auth (pas de dépendance hard au Hub)
- [ ] Sessions 90 jours, cookies `__Secure-*`, httpOnly, sameSite=lax
- [ ] Password hashé avec bcrypt 12+ rounds ou argon2id
- [ ] 2FA email opt-in documenté (ou tracé TODO si pas encore prêt)

### Rôles & permissions
- [ ] Les 4 rôles `owner`/`admin`/`member`/`viewer` sont définis dans `lib/auth/roles.ts`
- [ ] `canPerform(role, action)` utilisé dans toutes les routes API sensibles
- [ ] Tests e2e vérifient qu'un `viewer` ne peut pas écrire, qu'un `member` ne
      voit pas les ressources d'un autre `member`

### Invitations
- [ ] Table `Invitation` avec token 32 bytes + `expires_at` 7 jours
- [ ] Page `/invite/[token]` avec les 3 cas (invalide, connecté, pas connecté)
- [ ] Emails envoyés via Notifuse/Brevo avec template uniforme
- [ ] Audit log `member.invited` et `member.joined`

### Stripe
- [ ] Webhook `/api/webhooks/stripe` avec vérification signature
- [ ] Dédoublonnage idempotent sur `event.id`
- [ ] Config `PLAN_LIMITS` centralisée (pas de magic numbers)
- [ ] Paywall middleware sur toutes les routes payantes
- [ ] Trial freemium 7 jours par défaut

### Provisioning API
- [ ] Les 6 endpoints standards sont exposés (provision, update-plan, suspend,
      resume, delete, status)
- [ ] Vérification HMAC + timestamp drift 5 min
- [ ] Rate limit 10 req/min par IP
- [ ] Codes d'erreur standards (401/429/400/404/409)

### Audit log
- [ ] Table `audit_log` dans le schema de l'app
- [ ] Helper `logAudit()` dans `lib/audit.ts`
- [ ] Actions sensibles listées au §7.2 sont toutes loggées
- [ ] Rétention minimum 365 jours

### Health check
- [ ] `/api/health` retourne le format standard
- [ ] Timeout total 5s max
- [ ] Code HTTP 503 si `down`, 200 sinon
- [ ] Déclaré dans le Dockerfile / docker-compose healthcheck
- [ ] Utilisé par le rollback auto CI

### Déploiement & Dokploy
- [ ] Compose validé en local (`docker compose ... config`) + commit de la trace versionnée
- [ ] Modif d'infra reportée dans Dokploy (pas seulement commit repo)
- [ ] Secrets configurés via l'UI Dokploy (aucun secret en clair dans le repo)
- [ ] Cron/purges passent par Dokploy Schedule Jobs (pas de cron système)
- [ ] Aucun `docker compose up` direct en SSH sur le VPS

### Docs & TODO
- [ ] README de l'app référence ce document
- [ ] Tout écart (ex : Supabase Auth legacy) tracé dans `todo/TODO-LIVE.md`
- [ ] Session note ajoutée dans `todo/apps/<app>/TODO.md`

---

## 12. Contact & mise à jour

- **Modifier ce document** : PR reviewée par Robert, motif documenté dans le
  commit (`docs(saas-standards): ...`). Tout changement impacte potentiellement
  plusieurs apps — signaler dans TODO-LIVE les chantiers de mise en conformité.
- **Questions / cas non couverts** : ouvrir une note dans `todo/TODO-LIVE.md`
  section "Décisions en attente" avant de coder.
