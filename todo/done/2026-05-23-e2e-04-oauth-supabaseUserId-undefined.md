# [HUB] E2E — spec 04 OAuth fails sur supabaseUserId undefined (3 scénarios)

> **Sévérité** : 🟡 P1 — 3 tests E2E rouges, suite full bloquée pour promo prod
> **Owner** : agent Hub
> **Créé** : 2026-05-23 par agent e2e-harden-tolerances (OOS de son ticket)

## Contexte

Le run `pnpm e2e:staging:full` du 2026-05-23 (après durcissement spec 12 +
12bis livré) sort **149/155 passants, 6 échecs**. Tous les échecs sont sur
`e2e/staging-full/04-oauth-flows.spec.ts` :

- Scénario A (signup Google neuf → dashboard) — line 91
- Scénario B (signup Microsoft neuf) — line 123
- Scénario E (re-login Google idempotent) — line 141

Erreur commune (line 158) :

```
TypeError: expect(received).toMatch(expected)
Matcher error: received value must be a string
Received has value: undefined
> 158 |  expect(user.supabaseUserId).toMatch(/^[0-9a-f]{8}-.../);
```

→ Le body retourné par `GET /api/admin/users/[email]` n'a pas le champ
`supabaseUserId` posé pour les users OAuth mockés. Soit le shape admin a
changé (snake_case `supabase_user_id` vs camelCase `supabaseUserId`),
soit l'event `createUser` ne pose plus l'UUID pour le mock provider, soit
le test pointe sur le mauvais champ.

## Diagnostic rapide à faire

1. Lire `app/api/admin/users/[email]/route.ts` pour confirmer le shape
   (snake_case ou camelCase ?). Le spec 06 fait
   `body.user.supabase_user_id` (snake_case) avec succès → le 04 fait
   `user.supabaseUserId` (camelCase) qui retourne undefined.
2. Si c'est juste un mismatch naming, fixer le test (rapide).
3. Si l'event `createUser` du mock OAuth ne pose plus l'UUID, c'est une
   régression de auth.ts qui doit être tracée.

## Hypothèse principale

Le spec 06 fonctionne avec `body.user.supabase_user_id` (snake_case),
mais le spec 04 utilise `user.supabaseUserId` (camelCase). L'admin API
retourne probablement snake_case → fix simple côté test.

```ts
// Spec 04 actuel (broken) :
expect(user.supabaseUserId).toMatch(/^[0-9a-f]{8}-.../);

// Devrait probablement être :
expect(user.supabase_user_id).toMatch(/^[0-9a-f]{8}-.../);
```

Mais à vérifier en regardant le shape réel du body. Le test passait
peut-être avant un refactor de la route admin.

## Définition of done

- [ ] 3 scénarios spec 04 verts en staging full
- [ ] Si bug de naming → patch test, marker `[risk:low]`
- [ ] Si vraie régression auth.ts → fix code Hub + test, marker `[risk:medium]`
- [ ] `pnpm e2e:staging:full` retourne >= 152/155 (sur 155)

## Contraintes

- Pas d'impact sur la suite (les 149 autres passent)
- DEPLOY_ENV (jamais NODE_ENV)
