# Fix N+1 : runTrialTick cron — batch resolve owner email + active Stripe sub

> **Sévérité** : 🔴 P0
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Source** : `todo/2026-05-21-audit-perf-hub.md` §1.2

## Problème

`lib/trial/run-tick.ts` charge un batch de 100 rows trial via raw SQL puis,
pour CHAQUE row, appelle `resolveOwnerEmail()` (2 queries) et —dans Phase
3— `defaultHasActiveStripeSub()` (2 queries supplémentaires).

**Compte total des queries DB pour un batch de 100 trials à finaliser** :
- 1 raw SQL pour le `SELECT ... FOR UPDATE SKIP LOCKED`
- 100 × `prisma.tenant.findFirst()` (resolveOwnerEmail step 1)
- 100 × `prisma.user.findFirst()` (resolveOwnerEmail step 2, si pas de notifuseUserEmail)
- 100 × `prisma.tenant.findFirst()` (defaultHasActiveStripeSub step 1 — REDONDANT avec resolveOwnerEmail !)
- 100 × `prisma.subscription.findFirst()` (defaultHasActiveStripeSub step 2)

≈ **~400 queries DB séquentielles** au lieu de 4 batch queries `IN (...)`.

Le cron s'exécute toutes les 30 minutes avec `maxDuration = 300s` (5 min).
À 100 trials = ~10-30s de cron, à 500+ trials = risque de dépasser le
timeout et de skip des rows (qui seront reprises au tick suivant mais
ça décale tout).

## Reco fix

Refactor en 3 étapes : batch resolve avant la boucle, lookup en mémoire
dans la boucle.

### Étape 1 — Helper batch resolve owners

Ajouter dans `lib/trial/run-tick.ts` ou un nouveau fichier
`lib/trial/batch-resolve.ts` :

```typescript
/**
 * Batch résout les owners emails pour une liste de tenant identifiers.
 * Le `tenant_id` peut être : un UUID Tenant.id, un slug, ou un notifuseWorkspaceSlug.
 *
 * Retourne une Map<tenant_id_string, ownerEmail | null>.
 */
async function batchResolveOwnerEmails(
  tenantIds: string[],
): Promise<Map<string, string | null>> {
  if (tenantIds.length === 0) return new Map();

  const uuids = tenantIds.filter(isUuid);
  const nonUuids = tenantIds.filter((id) => !isUuid(id));

  const tenants = await prisma.tenant.findMany({
    where: {
      OR: [
        ...(uuids.length ? [{ id: { in: uuids } }] : []),
        ...(nonUuids.length ? [{ notifuseWorkspaceSlug: { in: nonUuids } }] : []),
        ...(nonUuids.length ? [{ slug: { in: nonUuids } }] : []),
      ],
    },
    select: {
      id: true,
      slug: true,
      notifuseWorkspaceSlug: true,
      userId: true,
      notifuseUserEmail: true,
    },
  });

  // Batch resolve users pour les tenants sans notifuseUserEmail direct
  const userUuids = [
    ...new Set(
      tenants
        .filter((t) => !t.notifuseUserEmail)
        .map((t) => t.userId)
    ),
  ];
  const users = userUuids.length
    ? await prisma.user.findMany({
        where: { supabaseUserId: { in: userUuids } },
        select: { supabaseUserId: true, email: true },
      })
    : [];
  const emailByUuid = new Map(
    users.map((u) => [u.supabaseUserId!, u.email]),
  );

  // Build une map de toutes les clés possibles → email
  const result = new Map<string, string | null>();
  for (const t of tenants) {
    const email = t.notifuseUserEmail ?? emailByUuid.get(t.userId) ?? null;
    result.set(t.id, email);
    if (t.slug) result.set(t.slug, email);
    if (t.notifuseWorkspaceSlug) result.set(t.notifuseWorkspaceSlug, email);
  }
  return result;
}

/**
 * Batch résout l'état "a une sub Stripe active" pour une liste de tenant ids.
 */
async function batchResolveHasActiveSub(
  tenantIds: string[],
): Promise<Map<string, boolean>> {
  if (tenantIds.length === 0) return new Map();

  const uuids = tenantIds.filter(isUuid);
  const nonUuids = tenantIds.filter((id) => !isUuid(id));

  const tenants = await prisma.tenant.findMany({
    where: {
      OR: [
        ...(uuids.length ? [{ id: { in: uuids } }] : []),
        ...(nonUuids.length ? [{ notifuseWorkspaceSlug: { in: nonUuids } }] : []),
        ...(nonUuids.length ? [{ slug: { in: nonUuids } }] : []),
      ],
    },
    select: { id: true, slug: true, notifuseWorkspaceSlug: true, userId: true },
  });

  const userUuids = [...new Set(tenants.map((t) => t.userId))];
  const subs = userUuids.length
    ? await prisma.subscription.findMany({
        where: {
          userId: { in: userUuids },
          status: { in: ['active', 'trialing', 'past_due'] },
        },
        select: { userId: true },
      })
    : [];
  const activeUuids = new Set(subs.map((s) => s.userId));

  const result = new Map<string, boolean>();
  for (const t of tenants) {
    const hasSub = activeUuids.has(t.userId);
    result.set(t.id, hasSub);
    if (t.slug) result.set(t.slug, hasSub);
    if (t.notifuseWorkspaceSlug) result.set(t.notifuseWorkspaceSlug, hasSub);
  }
  return result;
}
```

### Étape 2 — Adapter les 3 processeurs

Avant la boucle dans `processActivations`, `processEndingSoon`, et
`processFinalize`, batch resolve une seule fois :

```typescript
// processActivations
const tenantIds = rows.map((r) => r.tenant_id);
const emailMap = await batchResolveOwnerEmails(tenantIds);

for (const row of rows) {
  try {
    // ... update DB ...
    const ownerEmail = emailMap.get(row.tenant_id);
    if (ownerEmail) { /* send mail */ }
    // ...
  }
}
```

Pour `processFinalize`, ajouter aussi :

```typescript
const subMap = await batchResolveHasActiveSub(tenantIds);

for (const row of rows) {
  const hasSub = subMap.get(row.tenant_id) ?? false;
  if (hasSub) { /* converted */ } else { /* expired */ }
}
```

### Étape 3 — Préserver l'API publique pour tests

Les `TickDeps.hasActiveStripeSubForTenant` actuels passent un seul tenant
à la fois. Pour préserver la testabilité, garder la signature legacy mais
en interne batch-er. Option simple : ajouter une option `_batchSubMap` :

```typescript
export interface TickDeps {
  // ... existing ...
  /** OPT — si fourni, court-circuite le batch resolve interne. Sinon
   *  batch-resolve depuis la DB. Pour tests qui veulent injecter
   *  une réponse custom. */
  hasActiveStripeSubBatch?: (tenantIds: string[]) => Promise<Map<string, boolean>>;
  resolveOwnerEmailBatch?: (tenantIds: string[]) => Promise<Map<string, string | null>>;
}
```

Et les tests existants qui injectaient `hasActiveStripeSubForTenant` doivent
être migrés (ou on garde une couche de compat qui wrap le batch en single).

## Gain attendu

- Pour un batch de 100 trials : passage de **~400 queries séquentielles
  (~10-30s)** à **~6 queries batch (~500ms)**
- Phase 1 (activations) : 100 → 2 queries
- Phase 2 (notifications) : 100 → 2 queries
- Phase 3 (finalize) : 200 → 2 queries

Cron qui scale linéairement avec le nombre de rows, plus de risque de
dépasser `maxDuration=300s`.

## Tests à ajouter / mettre à jour

- Tests existants `__tests__/lib/trial/run-tick.test.ts` doivent passer
  sans modif (la sémantique est identique, juste la perf change)
- Ajouter un test "batch de 50 rows, vérifier que seulement 6 queries
  Prisma sont émises" (via `prisma.$on('query', ...)` ou un proxy mock)
- Vérifier idempotence : 2 ticks consécutifs sur les mêmes rows ne
  doublent pas les emails (déjà garanti par les UPDATE state + le
  endingSoonNotified=true mais s'assurer que la refacto ne casse pas)

## Risque

🟡 Moyen — refacto d'une logique cron qui touche aux mails users. À
tester en staging d'abord (déclencher le cron manuellement via
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/cron/trial-tick`),
vérifier que les compteurs `activated/notified/expired/converted` sont
identiques.

**Garde-fou** : déployer en parallèle, comparer la sortie de `runTrialTick`
sur staging vs prod, puis bascule.

## Marker commit

`[risk:medium]` — touche au cron trial. Reco écrite + e2e:staging:full
avant promotion main.
