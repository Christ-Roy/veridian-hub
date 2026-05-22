# Audit perf Hub — 2026-05-21

> **Sévérité** : 🟡 P1
> **Owner** : agent perf Hub
> **Créé** : 2026-05-21
> **Type** : rapport read-only (pas de code touché)

## Résumé exécutif

**Verdict global** : 🟡 perf raisonnable sur les routes publiques (P50 ≈
200ms, P95 ≈ 600ms staging single-instance), mais **3 dettes structurelles
visibles** qui vont mordre dès qu'on dépasse ~50 users actifs concurrents.

**Top 3 hotspots — par ordre de douleur attendue** :

1. 🔴 **`DashboardLayout` fait 4 awaits Prisma SÉQUENTIELS dont 2 sur la
   même table `users`** (cf §1.1). Chaque page `/dashboard/*` paye 4
   round-trips DB qui pourraient être 1 round-trip parallélisé via
   `Promise.all`. **Impact : +200-400ms par page render dashboard**, et
   c'est le path le plus chaud du Hub (toute la session user passe par
   ce layout). **Quick win : 30 min de refacto, divise par ~3 le temps
   serveur dashboard**.

2. 🔴 **`runTrialTick` cron : N+1 sur `resolveOwnerEmail` + `defaultHasActiveStripeSub`**
   (cf §1.2). Pour CHAQUE row trial traitée (limit 100/phase), le cron
   fait 2 queries supplémentaires (`tenant.findFirst` + `user.findFirst`
   pour résoudre l'email owner, `tenant.findFirst` + `subscription.findFirst`
   pour Stripe). Sur un batch de 100 trials à finaliser, ça fait **~400
   queries DB supplémentaires** au lieu de 2 (un `IN` resolve + un
   `IN` resolve). **Impact : cron qui passe de ~5s à ~30s à 100 trials,
   risque de dépasser maxDuration=300s à 1000+ trials**.

3. 🟡 **`prisma.tenant.findMany` sans `take` dans `list-tenants`,
   `delete-tenant`, `find-orphan-users` et `softDeleteTenantsForCustomer`**
   (cf §1.3, §2). Aujourd'hui le Hub a moins de 100 tenants en prod —
   transparent. À 10k tenants, ces routes chargent la table entière en
   mémoire. **`softDeleteTenantsForCustomer` cumule un N+1** : `for (t of tenants) { await update }` au lieu d'un seul `updateMany`.

**Capacité staging actuelle (single Docker container)** : tient confortablement
~20 reqs concurrentes (P99 = 2s sur health), s'écroule probablement à 100
reqs concurrentes (pas testé pour ne pas DOS staging). En prod (même
container), **on tient ~50-100 users actifs concurrents avant dégrader
visiblement** — au-delà, P95 dashboard > 2s et les webhooks Stripe
commencent à hit le timeout 30s.

**Pas de N+1 catastrophique en route chaude user-facing** — les pires
N+1 sont sur cron et webhooks (donc backend, pas user-perceived).

---

## 1. N+1 SQL identifiés

### 1.1 🔴 CRITIQUE — `DashboardLayout` 4 awaits séquentiels dont 2 redondants

**Fichier** : `app/dashboard/layout.tsx` (lignes 19-77)

```typescript
const user = await getCurrentUser();                  // 1 query users
const dbUser = await prisma.user.findUnique({...});   // 2e query users (REDONDANT)
const ws = await prisma.workspace.findFirst({...});   // query workspaces
const sub = await prisma.subscription.findFirst({...}); // query subscriptions
```

**Problèmes** :

1. `getCurrentUser()` fait déjà `findUnique` sur `users` (lib/auth/get-user.ts:39).
   Le 2e `findUnique` ligne 28 sélectionne `createdAt + name + image` qui
   pourrait être ajouté au `select` de `getCurrentUser` une bonne fois pour
   toutes (ou cette page-là, via un wrapper `getCurrentUserExtended`).
2. Les 3 queries restantes sont indépendantes → `Promise.all` les fait
   en parallèle au lieu de séquentiel.

**Reco fix** :

```typescript
// 1 query users élargie + 2 queries parallèles
const user = await getCurrentUserExtended(); // ajoute createdAt/name/image
if (!user) redirect('/login');

const [ws, sub] = await Promise.all([
  prisma.workspace.findFirst({
    where: { members: { some: { userId: user.id } }, deletedAt: null },
    select: { name: true },
  }),
  prisma.subscription.findFirst({
    where: { userId: userUuid(user), status: { in: ['trialing', 'active'] } },
    select: { id: true, status: true },
  }),
]);
```

**Gain attendu** : de ~4× round-trip DB (4×30ms = 120ms PG local) à 1+1×
round-trip (~60ms). Sur staging avec PG distant : **~200-400ms gagnés par
page render**.

**Impact** : toutes les pages `/dashboard/*` (workspace, billing, members,
settings, admin) sont concernées. C'est le path le plus chaud du Hub
post-login.

→ Ticket dédié : `todo/2026-05-21-fix-n1-dashboard-layout.md`

### 1.2 🔴 CRITIQUE — `runTrialTick` cron N+1 sur owner email + Stripe sub lookup

**Fichier** : `lib/trial/run-tick.ts` (lignes 370-440)

**Phase 1 (`processActivations`)** : boucle sur 100 rows max, et pour chaque
row appelle `resolveOwnerEmail()` qui fait :
- `prisma.tenant.findFirst({ where: { OR: [...] } })` (1 query)
- `prisma.user.findFirst({ where: { supabaseUserId } })` (1 query, si pas notifuseUserEmail)

**Phase 3 (`processFinalize`)** : pareil + `defaultHasActiveStripeSub` qui
ajoute :
- `prisma.tenant.findFirst()` (1 query, redondant avec resolveOwnerEmail)
- `prisma.subscription.findFirst()` (1 query)

**Total** : sur 100 trials à finaliser = **~400 queries supplémentaires**
au lieu de 2 (un batch `tenant.findMany({ where: { id: { in: ids } } })` +
un batch `user.findMany({ where: { supabaseUserId: { in: uuids } } })`).

**Reco fix** :

```typescript
// Avant la boucle, batch resolve owners + subs
const tenantIds = rows.map((r) => r.tenant_id);
const tenants = await prisma.tenant.findMany({
  where: { OR: [{ id: { in: tenantIds.filter(isUuid) } }, { notifuseWorkspaceSlug: { in: tenantIds } }] },
  select: { id: true, userId: true, notifuseUserEmail: true, notifuseWorkspaceSlug: true, slug: true },
});
const tenantByKey = indexTenants(tenants); // par id, slug, notifuseWorkspaceSlug

const uuids = [...new Set(tenants.map((t) => t.userId))];
const users = await prisma.user.findMany({
  where: { supabaseUserId: { in: uuids } },
  select: { supabaseUserId: true, email: true },
});
const emailByUuid = new Map(users.map((u) => [u.supabaseUserId, u.email]));

// Pour Phase 3 :
const subs = await prisma.subscription.findMany({
  where: { userId: { in: uuids }, status: { in: ['active', 'trialing', 'past_due'] } },
  select: { userId: true },
});
const activeSubUuids = new Set(subs.map((s) => s.userId));

// Puis boucle : lookups en mémoire (O(1)), pas de DB
```

**Gain attendu** : passage de O(N) queries à O(1) — sur 100 trials, de
**~30 secondes à ~3 secondes** (PG round-trip 30ms × 400 = 12s minimum
en local, plus en prod distant). À 500+ trials, on évite de dépasser
maxDuration=300s.

→ Ticket dédié : `todo/2026-05-21-fix-n1-trial-tick.md`

### 1.3 🟡 MOYEN — `softDeleteTenantsForCustomer` boucle update au lieu d'updateMany

**Fichier** : `lib/stripe/dispatcher.ts` (lignes 256-266)

```typescript
const tenants = await prisma.tenant.findMany({ where: { userId, deletedAt: null }, select: { id: true } });
for (const t of tenants) {
  await prisma.tenant.update({  // N updates séquentiels au lieu d'1 updateMany
    where: { id: t.id },
    data: { deletedAt: new Date(), status: 'deleted' },
  });
}
```

**Reco fix** :

```typescript
const now = new Date();
const result = await prisma.tenant.updateMany({
  where: { userId, deletedAt: null },
  data: { deletedAt: now, status: 'deleted' },
});
console.log(`[stripe-dispatch] customer.deleted ${customerId} → soft-deleted ${result.count} tenant(s)`);
```

**Gain** : 1 query au lieu de N. Sur un user qui aurait 5 tenants : 5×
round-trip DB → 1 round-trip. Côté webhook Stripe c'est important car le
dispatcher tient le webhook synchrone (timeout 30s).

### 1.4 🟡 MOYEN — `delete-tenant` même pattern boucle update

**Fichier** : `app/api/admin/delete-tenant/route.ts` (lignes 53-70)

Même pattern que 1.3 — `for (const tenant of tenants) { await prisma.tenant.update(...) }`. Remplacer par `updateMany`. Le `notifuseWorkspaceSlug`
warning peut être loggué dans une boucle séparée avant l'updateMany.

**Reco fix** :

```typescript
const tenants = await prisma.tenant.findMany({
  where: { userId: userUuid },
  select: { id: true, notifuseWorkspaceSlug: true },
});
for (const t of tenants) {
  if (t.notifuseWorkspaceSlug) {
    actions.push(`⚠️ Notifuse workspace ${t.notifuseWorkspaceSlug} still exists (manual cleanup needed)`);
  }
}
if (tenants.length > 0) {
  const result = await prisma.tenant.updateMany({
    where: { id: { in: tenants.map((t) => t.id) } },
    data: { status: 'deleted', deletedAt: new Date() },
  });
  actions.push(`Soft-deleted ${result.count} tenant(s)`);
}
```

### 1.5 🟢 BAS — `verifyMfaCode` bcrypt en série

**Fichier** : `lib/mfa/index.ts` (lignes 99-117)

```typescript
const candidates = await prisma.mfaCode.findMany({...});
for (const candidate of candidates) {
  const match = await bcrypt.compare(code, candidate.codeHash);  // ~80ms × N
  ...
}
```

**Note** : pas vraiment un N+1 SQL (1 seule query). Mais bcrypt.compare en
série coûte 80ms × candidats. Comme `issueMfaCode` invalide les anciens
avant d'en créer un nouveau, il devrait n'y avoir qu'1 candidat actif —
sauf race condition. **Risque réel faible**, on garde la boucle.

**Reco optionnelle** : si on veut être pédant, `Promise.all` les
bcrypt.compare et prendre le premier match — mais ça expose une side-channel
timing minuscule. Laisser tel quel.

---

## 2. Index manquants

### 2.1 ✅ Schema globalement bien indexé

Audit de `prisma/schema.prisma` :

| Table | Index présents | Verdict |
|---|---|---|
| `users` | `email` unique, `supabaseUserId` unique, `stripeCustomerId` unique | OK |
| `accounts` | `(provider, providerAccountId)` unique, `userId` | OK |
| `sessions` | `sessionToken` unique, `userId` | OK |
| `mfa_codes` | `(userId, expiresAt)` | OK |
| `workspaces` | (uniquement PK + FK implicite owner) | ⚠️ pas d'index sur `ownerId` |
| `workspace_members` | `(workspaceId, userId)` unique | OK |
| `invitations` | `(email, workspaceId)`, `token` unique | OK |
| `cross_app_invitations` | `inviteeEmail`, `(targetApp, targetWorkspaceId)`, `expiresAt`, `token` unique | OK |
| `subscriptions` | `userId`, `stripeCustomerId` unique, `status`, `stripeSubscriptionId` unique | OK |
| `tenants` | `userId`, `slug` unique, `status`, `deletedAt`, `notifusePlan` | OK |
| `provisioning_logs` | `(tenantId, createdAt desc)`, `level` | OK |
| `usage_metrics` | `(tenantId, metricType, timestamp desc)` | OK |
| `stripe_events` | PK `eventId`, `eventType`, `customerId` | OK |
| `webhook_dedup` | PK composite `(app, idempotencyKey)`, `receivedAt` | OK |
| `tenant_members` | PK `(tenantId, userId)`, `userId` | OK |
| `tenant_trials` | PK `(tenantId, app)`, `state`, partial `trialEndsAt WHERE trial_active` | OK |
| `audit_log` | `(action, createdAt)`, `targetId`, `(actor, createdAt desc)` | OK |

### 2.2 🟡 Index manquants identifiés

#### a. `workspaces.owner_id`

Pas d'index sur `ownerId`. La query `WorkspaceMembersPage` ne l'utilise
pas directement (elle passe par `members.some.userId`), mais le pattern
"workspace dont user est owner" reviendra sur la page admin → ajouter
quand le pattern apparaît.

**Risque actuel** : nul (table très petite, scan instantané).

#### b. `tenant_trials.eligible_at WHERE state='eligible'` (index partiel)

Le cron Phase 1 fait :

```sql
SELECT * FROM tenant_trials
WHERE state = 'eligible' AND eligible_at <= ?
ORDER BY eligible_at ASC LIMIT 100
FOR UPDATE SKIP LOCKED
```

L'index single-col `state` est utilisé, mais sur volume élevé (>10k
trials accumulés), un index partiel `(eligible_at) WHERE state='eligible'`
serait plus discriminant. Idem pour Phase 2 (`trial_started_at WHERE state='trial_active' AND ending_soon_notified=false`).

**À considérer si > 5000 trials non-terminaux**. Aujourd'hui 0 trials,
table neuve, **non-bloquant**.

#### c. `cross_app_invitations` index sur `inviteeEmail` ✓ mais pas sur `(inviteeEmail, acceptedAt)` filtré

L'idempotence dans `createCrossAppInvitation` cherche probablement les
invitations pending pour un email donné. Si la fonction fait
`WHERE inviteeEmail = ? AND acceptedAt IS NULL`, ajouter un index partiel
`(inviteeEmail) WHERE acceptedAt IS NULL` accélérerait — à vérifier dans
`lib/invitations/create.ts`.

### 2.3 Pas de JSONB GIN nécessaire (pour l'instant)

Vérification grep `metadata @>` / `jsonb_path` : **aucune query SQL raw
ne filtre sur metadata côté Hub**. Tous les filtres `metadata.notifuse_plan_source`
se font **après chargement de la row** (TypeScript memory access). Donc
pas besoin de GIN index. À surveiller si on ajoute une dashboard admin
qui filtre tenants par metadata.

---

## 3. Benchmarks P50/P95/P99 staging

### 3.1 Mesures séquentielles (1 req à la fois)

| Endpoint | P50 | P95 | P99 | Mean | Max |
|---|---|---|---|---|---|
| `/api/health` | 0.216s | 0.490s | 1.144s | 0.274s | 2.275s |
| `/api/pricing/plans` (cache HIT) | 0.182s | 0.604s | 0.941s | 0.294s | 2.749s |
| `/api/auth/providers` | 0.248s | 0.568s | 0.751s | 0.296s | - |
| `/api/auth/csrf` | 0.349s | 0.903s | 0.976s | 0.393s | - |
| `/api/auth/session` (unauth) | 0.228s | 0.787s | 0.938s | 0.322s | - |

**Observations** :

- **Aucun endpoint sous les 100ms même en best case** — staging single-container,
  pas de keep-alive global, cold path à chaque first request. En prod
  ce sera meilleur (warm container).
- `/api/pricing/plans` réponds `x-nextjs-cache: HIT` mais **avec des
  `set-cookie` authjs** dans la réponse — c'est ce qui empêche le CDN
  (Cloudflare/Traefik) de cacher en edge. Voir §4.2.
- `/api/auth/csrf` est le plus lent en moyenne (393ms) — Auth.js v5 fait
  visiblement un round-trip DB pour validate la session anonyme.

### 3.2 Mesures concurrentes (20 parallèles, 100 reqs total)

| Endpoint | P50 | P95 | P99 | Mean | Max |
|---|---|---|---|---|---|
| `/api/health` | 0.488s | 1.148s | 2.094s | 0.551s | 2.223s |
| `/api/pricing/plans` | 0.486s | 1.098s | 1.385s | 0.581s | 1.551s |
| `/api/auth/session` | 0.415s | 0.846s | 0.881s | 0.464s | 0.973s |

**Verdict scale** : Sous 20 reqs concurrentes, **P99 health = 2s** — pour
une route triviale qui retourne du JSON statique. Indique que le container
Next.js staging n'est pas dimensionné pour la concurrence (Node single
event loop + serveur HTTP qui multiplexe mal sans cluster mode).

**Capacité utile estimée** : **~50-100 users actifs concurrents** sur le
container Hub actuel avant que P95 dashboard dépasse 2s. Au-delà :
- bottleneck #1 = PG connections du pool Prisma (à mesurer)
- bottleneck #2 = Auth.js v5 callbacks qui font de la DB sur chaque session
- bottleneck #3 = DashboardLayout 4 queries séquentielles (§1.1)

**Pour scaler** :
- Quick win 1 : fixer §1.1 → diviser le temps DB du dashboard par 3
- Quick win 2 : passer Next.js en cluster mode (NODE_OPTIONS=`--max-old-space-size=2048`, PM2 cluster ou réplicas Docker)
- Mid-term : ajouter Redis pour Auth.js session store au lieu de PG

---

## 4. Cache config

### 4.1 Distribution `force-dynamic` vs `force-static`

| Route type | Count | Dynamic | Static | Verdict |
|---|---|---|---|---|
| `/api/*` | 49 | 39 | 1 (`pricing/plans`) | OK — la plupart sont user-spécifiques |
| `app/dashboard/*` | ~10 pages | (default = dynamic via cookie auth) | 0 | OK |

**Routes correctement statiques** :

- `app/api/pricing/plans/route.ts` : `force-static` + `revalidate=3600`,
  retourne le catalogue PLANS — payload byte-identique pour tous. Cache
  HIT confirmé via header `x-nextjs-cache: HIT`.

**Routes qu'on pourrait static-iser** :

- `app/api/health/route.ts` : actuellement default (dynamic). On pourrait
  passer en `force-static` + pas de revalidate (juste un ok timestamp).
  Mais c'est le healthcheck Docker, on veut qu'il re-touche le runtime
  pour vérifier que le container n'est pas zombie → garder dynamic.
  ✅ Décision OK.

- `app/api/auth/providers` : Auth.js gère le caching en interne — laisser.

### 4.2 🟡 Cache HTTP cassé par `set-cookie` Auth.js

**Problème** : `/api/pricing/plans` retourne `x-nextjs-cache: HIT` (Next.js
cache OK) MAIS le header `set-cookie: __Host-authjs.csrf-token=...` est
ajouté à la réponse par le middleware Auth.js. Les CDN respectent la règle
RFC : **`Set-Cookie` + `Cache-Control: public` = cache désactivé**.

**Conséquence** : Cloudflare / Traefik ne cachent **PAS** ce endpoint en
edge, et chaque user hit le container Next.js (qui répond depuis le cache
ISR interne mais paye quand même la latence TCP+TLS+Node).

**Reco fix** : exclure `/api/pricing/plans` du middleware Auth.js — ce
endpoint est PUBLIC, il n'a pas besoin de set-cookie csrf.

```typescript
// middleware.ts ou auth.config.ts
export const config = {
  matcher: ['/((?!api/pricing/plans|api/health|_next|favicon).*)'],
};
```

**Gain attendu** : 100% cache hit edge sur ce endpoint, latence depuis
edge ~10ms au lieu de ~200ms.

### 4.3 ✅ Pas d'usage abusif de `force-dynamic` sur des routes cachables

Audit OK — toutes les routes `force-dynamic` sont effectivement dynamiques
(user-specific, webhooks, cron, admin).

### 4.4 stale-while-revalidate

Utilisé sur `/api/pricing/plans` (`stale-while-revalidate=86400`). C'est le
bon pattern. Pas d'autre endpoint qui en bénéficierait au lancement.

---

## 5. Awaits séquentiels à paralléliser

### 5.1 🔴 `app/dashboard/layout.tsx` lignes 19, 28, 41, 57

Cf §1.1. Le pire offender. 4 awaits dont 2 redondants sur la même table.

### 5.2 🟡 `lib/stripe/dispatcher.ts` `softDeleteTenantsForCustomer`

```typescript
// lignes 234-247 : 2 awaits qui pourraient être Promise.all
let userId = sub?.userId ?? null;
if (!userId) {
  const userByCustomer = await prisma.user.findFirst({...});
}
```

**Note** : c'est volontaire (fallback si pas trouvé dans `subscriptions`). On
ne peut pas paralléliser facilement sans charger les 2 même quand le 1er
suffit. **À laisser tel quel**, le path `customer.deleted` est rare.

### 5.3 🟡 `utils/stripe/prisma-sync.ts:manageSubscriptionStatusChange`

```typescript
const uuid = await resolveUserUuid(customerId);          // 1-3 queries DB + Stripe API call
await prisma.user.updateMany({...});                      // 1 query
const subscription = await stripe.subscriptions.retrieve(...); // 1 Stripe API call
// ...
const tenant = await prisma.tenant.findFirst({...});     // 1 query
await prisma.subscription.upsert({...});                  // 1 query
await prisma.tenant.update({...});                        // 1 query
await client.updatePlan({...});                           // 1 HTTP call HMAC Notifuse (3 retries)
```

**Awaits séquentiels potentiellement parallélisables** :

- `prisma.user.updateMany` (best-effort backfill) peut être **fire-and-forget**
  (pas attendre, juste log d'erreur si fail). C'est du bonus, pas du critical path.
- `stripe.subscriptions.retrieve` peut être parallélisé avec
  `prisma.tenant.findFirst({ userId: uuid })` une fois qu'on a le `uuid`
  → `Promise.all`.

**Gain attendu** : ~100-200ms par webhook Stripe (round-trip Stripe API
+ DB en parallèle). À 100+ webhooks/jour à terme, c'est marginal.

**Reco** : tagger ça en quick-win mais pas P0.

### 5.4 ⚠️ Webhook Stripe `dispatchStripeEvent` : Stripe API dans le path synchrone

Le webhook Stripe a un timeout de 30s côté Stripe. Si la propagation HMAC
vers Notifuse pend (3 retries × 5s timeout = 15s worst case) + la query
Stripe API (`subscriptions.retrieve`, ~500ms) + DB queries (~50ms × 4) =
on peut tangenter le 30s sur un Notifuse lent.

**Reco mid-term** : passer en **mode async** — le webhook répond 200 dès
que `persistStripeEvent` est OK, puis dispatch en background (via une
queue ou un setImmediate). Aujourd'hui pas critique, mais à câbler avant
1000+ webhooks/jour.

---

## 6. Eager loading sur-spécifié

### 6.1 ✅ `getCurrentUser` est OK

`select` minimal (5 fields), pas de `include`. Bien.

### 6.2 🟡 `app/api/admin/users/[email]/route.ts:findUnique` charge `accounts` + `sessions` complets

```typescript
const user = await prisma.user.findUnique({
  where: { email },
  select: {
    ...
    accounts: { select: { provider, providerAccountId, type } },
    sessions: { select: { expires: true } },
  },
});
```

Sur un user qui a beaucoup de sessions historiques, `sessions: { expires: true }`
peut charger des centaines de rows pour juste retourner `sessions.length`.

**Reco fix** : utiliser `_count` Prisma au lieu de charger les rows :

```typescript
select: {
  ...
  _count: { select: { sessions: true } },
  accounts: { select: { provider: true, providerAccountId: true, type: true } },
}
```

Puis `active_sessions: user._count.sessions`. Pareil pour `accounts` si on
ne veut que le count, mais ici on en a besoin des détails.

### 6.3 🟡 Auth.js `Credentials.authorize` charge `user.accounts: true` ALL

`auth.ts` ligne 87-90 :

```typescript
const user = await prisma.user.findUnique({
  where: { email },
  include: { accounts: true },  // charge TOUS les accounts (Google + Microsoft + Credentials)
});
```

On veut juste trouver le `credentials` provider. À chaque tentative de
login, on charge l'arbre complet des accounts. **Reco fix** :

```typescript
const user = await prisma.user.findUnique({
  where: { email },
  select: {
    id: true, email: true, name: true, image: true,
    accounts: {
      where: { provider: 'credentials' },
      select: { access_token: true },
      take: 1,
    },
  },
});
const credsAccount = user?.accounts[0];
```

**Gain** : sur un user qui a 3 providers liés (Google + Microsoft +
Credentials), on charge 1 row au lieu de 3. Marginal mais à 1M de tentatives
de brute-force ça compte.

### 6.4 ✅ `BillingPage` charge tout `Subscription.price.product` mais l'utilise

`price.include.product` est nécessaire pour afficher le nom du plan +
prix. OK.

---

## 7. Tickets ouverts (créés en parallèle de ce rapport)

| Ticket | Sévérité | Description |
|---|---|---|
| `2026-05-21-fix-n1-dashboard-layout.md` | 🔴 P0 | 4 awaits séquentiels dont 2 redondants, divisera le temps render dashboard par ~3 |
| `2026-05-21-fix-n1-trial-tick.md` | 🔴 P0 | N+1 sur resolveOwnerEmail + defaultHasActiveStripeSub, ~400 queries vs 2 sur batch 100 |
| `2026-05-21-fix-n1-soft-delete-tenants.md` | 🟡 P1 | Boucles update au lieu d'updateMany dans dispatcher + delete-tenant |
| `2026-05-21-fix-cache-cookies-pricing-plans.md` | 🟡 P1 | Set-cookie Auth.js casse cache CDN sur /api/pricing/plans |

---

## 8. Quick wins perf (< 1h chacun)

1. **§1.1 — Fix DashboardLayout 4 awaits** : 30 min, `Promise.all` + select
   élargi sur getCurrentUser. **Impact P95 dashboard : -300ms**.
2. **§4.2 — Exclure /api/pricing/plans du middleware Auth.js** : 15 min,
   1 ligne dans matcher. **Impact : 100% cache edge HIT, latence ~20ms
   au lieu de 200ms**.
3. **§1.3 + §1.4 — Remplacer 2 boucles update par updateMany** : 20 min
   chacun. **Impact : -N×round-trip DB sur ces endpoints**.
4. **§6.2 — Utiliser _count au lieu de charger sessions** : 10 min. **Impact :
   pages admin users plus rapides à mesure que les sessions historiques
   s'accumulent**.
5. **§6.3 — Filter `accounts` provider='credentials' dans authorize** :
   10 min. **Impact : -2/3 du payload DB par tentative login Credentials**.

Total : ~1h30 de refacto → divise par 3 le temps serveur des paths chauds.

---

## 9. Sprints perf (>4h)

1. **§1.2 — Refacto runTrialTick pour batch resolve** : 4h (refacto + tests).
   **Impact : cron qui scale à 10k+ trials sans dépasser maxDuration**.
2. **§5.4 — Webhook Stripe en mode async (queue ou setImmediate)** : 6-8h.
   **Impact : webhook qui répond 200 en <500ms quel que soit l'état des
   apps downstream, plus de risque timeout Stripe**.
3. **§3.2 — Cluster mode Next.js (PM2 cluster ou Docker replicas)** :
   4h (test charge + monitoring). **Impact : capacité du Hub multipliée
   par le nombre de cores (~4× sur le VPS actuel)**.
4. **Mid-term — Redis pour Auth.js session store** : 8-12h. Sortir le state
   session de PG, accélérer `auth()` callback ~50ms à ~5ms. À considérer
   quand on dépasse 200+ users actifs concurrents.

---

## 10. Verdict scale-up final

**Capacité actuelle (avant fixes)** : ~50-100 users actifs concurrents
avant dégradation visible (P95 dashboard > 2s).

**Après quick wins §8** : ~150-250 users concurrents (3× boost essentiellement
sur le path dashboard layout).

**Après sprint §9.3 (cluster mode)** : ~500-1000 users concurrents (× nb
de cores).

**Goulet d'étranglement final** : pool PG + Auth.js session DB. À 1000+
users, il faudra Redis + dimensionnement PG.

**Pas de risque CRITIQUE imminent** — le Hub aujourd'hui a < 50 users en
prod, on est très loin du plafond. Les fixes proposés sont du polissage
pré-scale-up.
