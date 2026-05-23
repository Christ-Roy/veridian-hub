# [HUB] E2E fix — Admin API idempotence + legacy sub display (specs 13, 15)

> **Sévérité** : 🟡 P1 — bloque promo main (2 specs)
> **Owner** : sub-agent Opus dédié, worktree isolé
> **Créé** : 2026-05-23 par team lead après `pnpm e2e:staging:full`

## Specs en échec

### Spec 13 — Admin API security S6

`e2e/staging-full/13-admin-api-security.spec.ts` :
- "Journey 13 > S6 Idempotence link-app > link 2× même tenant → mêmes IDs (pas de doublon)"
- Erreur : `expect(received).toBe(expected)`

Probablement la route admin `POST /api/admin/tenants/link-app` n'est plus idempotente — soit elle crée un doublon, soit elle renvoie un ID différent au 2e appel.

### Spec 15 — Legacy tenants paths Cas 4

`e2e/staging-full/15-legacy-tenants-paths.spec.ts` :
- "Cas 4 — Subscription legacy sans users.stripe_customer_id > GET /dashboard/billing affiche bien la subscription legacy"
- Erreur : `/dashboard/billing doit afficher la sub legacy`

La sub legacy (sans `users.stripe_customer_id`) n'est plus affichée dans `/dashboard/billing`. Lié au mapping `LEGACY_STRIPE_PRICE_MAPPING` ajouté aujourd'hui ? Vérifier que le composant qui rend la page lit bien aussi les subs sans `stripe_customer_id` côté User (probablement via subscription.customer direct).

## Action attendue

1. Reproduire chaque spec individuellement
2. Lire le code de la route / composant concerné
3. Identifier la régression (probablement liée au sprint refill leads ou legacy-price-mapping commits récents)
4. Fix + tests Nuclear (Mode Nuclear actif sur ces routes)
5. Push staging

## Contraintes

- Marker `[risk:medium]` (admin API + billing UI)
- Tests Nuclear obligatoires
- Coordonner avec les 3 autres agents (Stripe webhook, trial state, SQL helper) pour éviter conflits push staging — rebase systématique avant push

---

## Résolution — 2026-05-23 (commit e56e77b)

**Diagnostic réel** (différent de l'hypothèse du ticket) :

### Spec 13 S6 — pas un bug d'idempotence

Le `linkApp` est correctement idempotent — unit test `link 2× consécutifs
retournent le même tenantId` passe (et passait déjà avant). En isolation,
S6 E2E passait aussi. Le bug se manifeste UNIQUEMENT en mode séquentiel
(spec 13 + spec 15 ensemble) :

1. `withRateLimitRetry` n'avait que 2 retries
2. Traefik staging réécrit `x-forwarded-for` → `freshIpHeader()` ne
   bypasse rien, tout part de la même IP côté Hub
3. Rate-limit admin = 30/min/IP partagé sur toute la suite
4. Le call `users/create` dans S6 perdait son budget → 429 silencieux
5. Le call `link-app` qui suit recevait 404 `user_not_found`
6. La suite interprétait ça à tort comme "idempotence cassée"

**Fix** : `withRateLimitRetry` à 5 retries + cap 65s sur Retry-After
+ nouveau helper `setupCall()` qui assert le status attendu et throw
explicitement sur cascade rate-limit (fail-fast au lieu de polluer le
diagnostic du test suivant).

### Spec 15 Cas 4 — pas un bug du LEGACY_STRIPE_PRICE_MAPPING

La sub legacy EST bien fetchée par `prisma.subscription.findMany` et
rendue par `<SubscriptionCard>`. Le test cherchait juste les mauvais
strings (`"Current Plan"` / `"No active subscription"` anglais — la page
est en français figé depuis le refactor billing fa75dfd).

**Fix** : assertions alignées sur `"Mon abonnement"` / `"formule Veridian"`
/ `"Aucun abonnement actif"` (français).

### Tests Nuclear ajoutés

- `__tests__/lib/admin/link-app.test.ts` : test E2E-style "link 2× consécutifs
  retournent le même tenantId — pas de doublon"
- `__tests__/app/dashboard/billing/SubscriptionCard.test.tsx` : test
  "legacy : sub sans price (planName fallback Abonnement, 0 €)"

### Validation

- 1299/1299 vitest passed
- 33/33 E2E spec 13+15 séquentiel passed (S6 = 203ms, Cas 4 = 1.2s)
- Push staging `[risk:medium]` (admin API + billing UI)
