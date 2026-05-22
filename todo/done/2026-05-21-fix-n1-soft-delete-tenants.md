# Fix N+1 : remplacer 2 boucles `update` par `updateMany` dans soft-delete

> **Sévérité** : 🟡 P1
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Source** : `todo/2026-05-21-audit-perf-hub.md` §1.3 + §1.4

## Problème

Deux endroits dans le codebase font `findMany` puis `for (...) await update(...)` au lieu d'un seul `updateMany`. Sur un user qui a N tenants,
ça fait N round-trips DB séquentiels au lieu d'1.

### Endroit 1 : `lib/stripe/dispatcher.ts:softDeleteTenantsForCustomer` (lignes 256-266)

```typescript
const tenants = await prisma.tenant.findMany({
  where: { userId, deletedAt: null },
  select: { id: true },
});

for (const t of tenants) {
  await prisma.tenant.update({
    where: { id: t.id },
    data: { deletedAt: new Date(), status: 'deleted' },
  });
}
```

**Contexte** : webhook Stripe `customer.deleted`. Le webhook a un timeout
de 30s côté Stripe. Sur un user qui aurait 5 tenants, on cumule 5×
round-trip DB inutiles.

### Endroit 2 : `app/api/admin/delete-tenant/route.ts` (lignes 53-70)

```typescript
const tenants = await prisma.tenant.findMany({
  where: { userId: userUuid },
  select: { id: true, notifuseWorkspaceSlug: true },
});

for (const tenant of tenants) {
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { status: 'deleted', deletedAt: new Date() },
  });
  actions.push(`Soft-deleted tenant ${tenant.id}`);

  if (tenant.notifuseWorkspaceSlug) {
    actions.push(`⚠️ Notifuse workspace ${tenant.notifuseWorkspaceSlug} still exists (manual cleanup needed)`);
  }
}
```

**Contexte** : endpoint admin pour supprimer un tenant. Pas critique en
production (rarement appelé), mais c'est un mauvais pattern à reproduire.

## Reco fix

### Fix 1 : `softDeleteTenantsForCustomer`

```typescript
async function softDeleteTenantsForCustomer(customerId: string): Promise<void> {
  // ... resolve userId (inchangé) ...

  if (!userId) {
    console.warn(
      `[stripe-dispatch] customer.deleted ${customerId} — no user found, nothing to soft-delete`,
    );
    return;
  }

  const now = new Date();
  const result = await prisma.tenant.updateMany({
    where: { userId, deletedAt: null },
    data: { deletedAt: now, status: 'deleted' },
  });

  console.log(
    `[stripe-dispatch] customer.deleted ${customerId} → soft-deleted ${result.count} tenant(s)`,
  );
}
```

Gain : N → 1 query.

### Fix 2 : `delete-tenant/route.ts`

```typescript
// Récupère les tenants pour logger les notifuseWorkspaceSlug avant updateMany
const tenants = await prisma.tenant.findMany({
  where: { userId: userUuid },
  select: { id: true, notifuseWorkspaceSlug: true },
});

for (const t of tenants) {
  if (t.notifuseWorkspaceSlug) {
    actions.push(
      `⚠️ Notifuse workspace ${t.notifuseWorkspaceSlug} still exists (manual cleanup needed)`,
    );
  }
}

if (tenants.length > 0) {
  const result = await prisma.tenant.updateMany({
    where: { id: { in: tenants.map((t) => t.id) } },
    data: { status: 'deleted', deletedAt: new Date() },
  });
  actions.push(`Soft-deleted ${result.count} tenant(s)`);
} else {
  actions.push('No tenant row found');
}
```

Note : on garde le `findMany` car on a besoin d'extraire les
`notifuseWorkspaceSlug` pour logger les warnings avant l'update.

## Gain attendu

- Cas Stripe `customer.deleted` : -N×round-trip DB → -50 à -250ms pour
  un user à 5 tenants (en prod typique 1-3 tenants par user → marginal
  mais propre)
- Cas admin `delete-tenant` : idem, plus une garantie d'atomicité (updateMany
  est atomique sur Postgres)

## Tests à ajouter

- Vérifier comportement avec 0 tenant (ne doit pas crash)
- Vérifier idempotence : appeler le webhook 2× → seuls les non-deletés
  sont marqués
- Couvrir les warnings notifuseWorkspaceSlug dans le test admin

## Risque

🟢 Faible. Changement de syntaxe Prisma équivalent fonctionnellement.

## Marker commit

`[risk:low]` — refacto perf, sémantique préservée.
