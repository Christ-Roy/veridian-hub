# [HUB] E2E fix — race condition `/api/admin/users/create` sur duplicate email (500 au lieu de already_existed)

> **Sévérité** : 🔴 P1 — vrai bug Hub, peut arriver en prod si 2 admin créent en parallèle
> **Owner** : sub-agent Opus dédié
> **Créé** : 2026-05-23 par team lead après run 3 E2E

## Symptôme

Spec 13 S5 : "5 calls create simultanés sur le même email → 1 created + 4 already_existed"

Got `200,500,200,200,200` au lieu de `200,200,200,200,200`.

**1 appel sur 5 plante en 500** au lieu de retourner `already_existed` proprement.

## Diagnostic probable

`POST /api/admin/users/create` n'est pas thread-safe sur la contrainte unique email. Pattern probable :

```ts
const existing = await prisma.user.findUnique({ where: { email } });
if (existing) return { ok: true, status: 'already_existed', user: existing };
const newUser = await prisma.user.create({ data: { email, ... } });
return { ok: true, status: 'created', user: newUser };
```

Si 2 requêtes passent `findUnique` simultanément AVANT que la première `create` ne commit, les 2 tentent un `prisma.user.create` → la 2e plante avec `P2002 unique constraint violation` → 500 si pas catché.

## Fix attendu

Refactor pour utiliser un pattern atomique :

```ts
try {
  const newUser = await prisma.user.create({ data: { email, ... } });
  return { ok: true, status: 'created', user: newUser };
} catch (e) {
  if (e.code === 'P2002') {
    const existing = await prisma.user.findUnique({ where: { email } });
    return { ok: true, status: 'already_existed', user: existing };
  }
  throw e;
}
```

OU utiliser `prisma.user.upsert({ where: { email }, create: ..., update: {} })` qui est atomique.

## Tests à ajouter

`__tests__/api/admin/users/create.test.ts` (ou existant) :
- "duplicate email — 500 races se résolvent en 4 already_existed + 1 created (jamais 500)"
- "P2002 sur create simulé → catch + findUnique + return already_existed"
- "autre erreur Prisma (P1001 timeout, etc.) → 500 re-throw"

## Définition of done

- [ ] Refactor route avec pattern atomique (try/catch P2002 OU upsert)
- [ ] Tests Nuclear couvrent le scénario race
- [ ] Spec 13 S5 passe : 5 calls simultanés → 1 created + 4 already_existed (0 erreur 500)
- [ ] Marker commit `[risk:medium]` (touche admin user creation)
- [ ] DEPLOY_ENV (jamais NODE_ENV)

## Contraintes

- Stop sur staging
- Rebase avant push (autre agent actif sur bypass rate-limit)
- Pas de breaking change sur le shape de réponse
