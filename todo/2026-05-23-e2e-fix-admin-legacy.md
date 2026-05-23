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
