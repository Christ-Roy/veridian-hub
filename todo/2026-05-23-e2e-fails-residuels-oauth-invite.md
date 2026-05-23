# [HUB] E2E fails résiduels — OAuth mock (spec 04) + invite UX (spec 11)

> **Sévérité** : 🟡 P1 — bloque promo main (9 specs sur 154, hors scope rate-limit)
> **Owner** : à attribuer
> **Créé** : 2026-05-23 après fix cascade rate-limit (commits c5df1c7 + 7b07ad2)

## Contexte

Run `pnpm e2e:staging:full` post-fix bypass rate-limit + alignement
ADMIN_SECRET → **145/154 passants (94%, 1 skipped)**.

Les 5 specs cascadant historiquement à cause du rate-limit
(13/05/15/07/11) sont maintenant verts à 100% sauf 3 sous-tests
restants de spec 11. Le ticket
`2026-05-23-e2e-fix-admin-rate-limit-cascade.md` est résolu.

Restent **9 fails distincts** sur 2 specs, sans rapport avec le
rate-limit :

## Spec 04 — OAuth mock (6 fails)

`e2e/staging-full/04-oauth-flows.spec.ts`

| Test | Erreur |
|---|---|
| Scénario A : signup Google neuf → dashboard | `TypeError: expect(received).toMatch(expected)` (ligne ~91) |
| Scénario B : signup Microsoft neuf | `TypeError: expect(received).toMatch(expected)` (ligne ~123) |
| Scénario E : re-login Google idempotent | `TypeError: expect(received).toMatch(expected)` (ligne ~141) |

(× 2 retries chacun = 6 lignes dans le rapport).

**Hypothèse rapide** : `received` est probablement `undefined` ou `null`,
toMatch throw au lieu d'échouer proprement. Probable signal qu'un
`supabaseUserId` ou une URL de redirect n'est pas posé sur la session
mock OAuth. Lié à l'évolution récente du mock provider
(`lib/auth/mock-oauth-provider.ts`) ou à la migration UUID bridge ?

**Investigation suggérée** :
1. Lire `e2e/staging-full/04-oauth-flows.spec.ts:91` pour identifier
   le `toMatch()` qui crashe
2. Trouver ce que la spec attend dans la session post-signup OAuth
3. Vérifier ce que le mock OAuth provider pose actuellement
4. Tester en isolation : `pnpm exec playwright test 04-oauth-flows.spec.ts`

## Spec 11 — Invite page UX (3 fails)

`e2e/staging-full/11-invite-page-ux-flow.spec.ts`

| Test | Erreur |
|---|---|
| S4 : page rend le bouton "Accepter" (data-testid=invite-accept-button) | `expect(locator).toBeVisible() failed` (ligne ~215) — **1 flaky** |
| S6 : re-accept invitation déjà consumed → alerte error "déjà acceptée" | `expect(received).toContain(expected)` (ligne ~302) |

**Hypothèse rapide** :
- S4 : flaky → probable timing UI (selector qui apparaît tard, attente
  manquante).
- S6 : message d'erreur dans l'UI a probablement été reformulé (ex:
  "déjà utilisée" au lieu de "déjà acceptée"). Lire la page
  `/invite/[token]` côté composant pour voir le wording actuel.

## Investigations à mener

1. Reproduire chaque spec isolément (`pnpm exec playwright test <spec>`)
2. Lire le code de la route / composant concerné
3. Identifier la régression
4. Fix + tests Nuclear si modif business logic
5. Re-run suite complète, viser 154/154

## Contraintes

- Marker commit selon impact (spec 04 = `[risk:medium]` probable car
  touche OAuth ; spec 11 = `[risk:medium]` car invite UX)
- Stop sur staging avant promo main
- Pas de promo prod tant que ces 9 fails ne sont pas résolus ou
  documentés comme "flaky connu / acceptable"
