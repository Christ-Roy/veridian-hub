# Fix N+1 : DashboardLayout fait 4 awaits Prisma séquentiels dont 2 redondants

> **Sévérité** : 🔴 P0
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Source** : `todo/2026-05-21-audit-perf-hub.md` §1.1

## Problème

`app/dashboard/layout.tsx` (lignes 19-77) chaîne 4 awaits Prisma séquentiels
sur **chaque** render de page dashboard. Deux d'entre eux interrogent la
même table `users` pour le même ID — c'est de la double-lecture pure.

```typescript
const user = await getCurrentUser();                    // ↘ 1 SELECT users WHERE id = ?
if (!user) redirect('/login');

const dbUser = await prisma.user.findUnique({           // ↘ 2e SELECT users WHERE id = ?  (REDONDANT)
  where: { id: user.id },
  select: { createdAt: true, name: true, image: true },
});

const ws = await prisma.workspace.findFirst({...});     // ↘ SELECT workspaces JOIN members
const sub = await prisma.subscription.findFirst({...}); // ↘ SELECT subscriptions
```

**Impact mesuré** : ~4× round-trip DB séquentiel, dans le path le plus
chaud du Hub (toutes les pages `/dashboard/*` paient ce layout). En staging
ça représente ~120-200ms de latence serveur par render. En prod (PG distant,
~50ms RTT par query) ça monte à 200-400ms.

## Reco fix

### 1. Élargir `getCurrentUser` (ou ajouter `getCurrentUserExtended`)

Dans `lib/auth/get-user.ts`, ajouter une variante :

```typescript
export type AuthUserExtended = AuthUser & {
  createdAt: Date;
};

export async function getCurrentUserExtended(): Promise<AuthUserExtended | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      supabaseUserId: true,
      createdAt: true,
    },
  });
  return user;
}
```

### 2. Paralléliser les 2 queries restantes via `Promise.all`

Dans `app/dashboard/layout.tsx` :

```typescript
import { getCurrentUserExtended, userUuid } from '@/lib/auth/get-user';

const user = await getCurrentUserExtended();
if (!user) redirect('/login');

const [ws, sub] = await Promise.all([
  prisma.workspace.findFirst({
    where: {
      members: { some: { userId: user.id } },
      deletedAt: null,
    },
    select: { name: true },
  }).catch((err) => {
    console.error('[Dashboard Layout] Failed to fetch workspace name:', err);
    return null;
  }),
  prisma.subscription.findFirst({
    where: {
      userId: userUuid(user),
      status: { in: ['trialing', 'active'] },
    },
    select: { id: true, status: true },
  }).catch((err) => {
    console.error('[Dashboard Layout] Failed to fetch subscription:', err);
    return null;
  }),
]);

const userCreatedAt = user.createdAt.toISOString();
const currentWorkspaceName = ws?.name ?? null;
const hasActiveSubscription = !!sub;
```

**Attention** : `userUuid(user)` throw si pas de supabaseUserId. Garder la
sémantique actuelle (try/catch côté caller).

## Gain attendu

- 4 round-trips DB séquentiels → 1 round-trip + 1 batch parallèle
- **-200 à -400ms par page dashboard** selon le RTT PG
- Toutes les pages `/dashboard/*` profitent (workspace, billing, members,
  settings, admin, …)

## Tests à ajouter / mettre à jour

- Vérifier qu'un user sans supabaseUserId ne crash pas le layout (déjà
  géré par try/catch — ne pas régresser)
- Vérifier que `hasActiveSubscription` reste true si la query workspace
  rate (les 2 queries doivent être indépendantes)
- Bench avant/après sur dev local (`pnpm dev` + DevTools Network)

## Risque

🟢 Très faible. Pas de changement de logique métier, juste de la
parallélisation. Aucun changement de signature publique.

## Marker commit

`[risk:low]` — refacto perf sans impact comportement, tests existants
suffisent.
