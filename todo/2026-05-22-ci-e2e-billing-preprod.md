# CI — Brancher les E2E billing sur le vrai compte Stripe PREPROD

> **Sévérité** : 🟢 P2 — amélioration de couverture, pas un blocage
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : audit anti-fuite Stripe 2026-05-22 (commit `387e90f`), tâche sprint #8

## Contexte

L'audit anti-fuite clés Stripe du 2026-05-22 a confirmé que le repo est
**SAFE** : aucune clé LIVE en clair, clé LIVE confinée au runtime prod
(`compose/prod.yml` via interpolation ENV Dokploy), garde-fou pre-push
`check-no-stripe-live-key.sh` en place.

**Mais il a aussi révélé un écart** entre l'intention et l'implémentation :

- Intention (décision Robert) : la CI E2E billing tape le **compte Stripe
  PREPROD** (`acct_1SqkTM`, clés `STRIPE_*_PREPROD`).
- Réalité actuelle : les specs E2E billing (`e2e/staging-full/09`, `12`,
  `14`, `16`) utilisent toutes `new Stripe('sk_test_fake')` et **tolèrent
  un Stripe non-configuré** (spec 12 S7 accepte un `503
  stripe_price_not_configured`). `compose/staging.yml` n'injecte aucune
  vraie clé Stripe (`STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY_TEST:-sk_test_fake}`).
  `hub-staging.yml` n'a aucun job E2E billing et son `.env` ne contient
  aucune clé Stripe. `gh secret list` : aucun secret Stripe.

Conséquence : les E2E billing ne valident PAS un vrai aller-retour Stripe
(checkout session réelle, webhook signé réel). C'est sûr mais incomplet —
un bug sur un price ID mal configuré ou une signature webhook ne serait
pas attrapé en CI.

## Travail à faire

1. **Ajouter les 3 clés du compte PREPROD `acct_1SqkTM` en GitHub Secrets**
   (`gh secret set` sur `veridian-hub`) :
   - `STRIPE_SECRET_KEY_TEST` (`sk_test_…` du compte preprod)
   - `STRIPE_PUBLISHABLE_KEY_TEST` (`pk_test_…` du compte preprod)
   - `STRIPE_WEBHOOK_SECRET_TEST` (`whsec_…` du endpoint webhook preprod)
   Les valeurs sont dans `~/credentials/.all-creds.env`.

2. **Injecter ces secrets dans le `.env` staging via `hub-staging.yml`** —
   ajouter les 3 `printf` dans le bloc qui écrit `$ENVFILE` (lignes ~147-156),
   et les déclarer dans `env:` du step `Deploy stack`. `compose/staging.yml`
   les consomme déjà via `${STRIPE_SECRET_KEY_TEST:-sk_test_fake}` — le
   fallback `sk_test_fake` disparaît dès que la vraie valeur est fournie.

3. **Faire tourner `e2e/staging-full/09-12-14-16` contre le vrai compte
   preprod** — soit en ajoutant un job E2E billing dans `hub-staging.yml`,
   soit en documentant que `pnpm e2e:staging:full` les couvre une fois le
   `.env` staging enrichi. Les specs devront alors valider une vraie
   checkout session (`https://checkout.stripe.com/…`) au lieu de tolérer
   le 503.

## Garde-fous à respecter

- ⚠️ **NE JAMAIS** mettre une clé `sk_live_` ici — uniquement les clés
  TEST du compte preprod. Le garde-fou `check-no-stripe-live-key.sh`
  (`.husky/pre-push` §7) refuse tout littéral `sk_live_` de toute façon.
- Le compte preprod doit avoir les Products/Prices créés (cf. ticket
  `todo/2026-05-21-pricing-sync-stripe-products.md` et sprint billing #2).

## DoD

- [ ] 3 secrets `STRIPE_*_TEST` (preprod) présents dans GitHub Secrets veridian-hub
- [ ] `hub-staging.yml` injecte ces 3 clés dans le `.env` staging
- [ ] Les E2E billing (`09/12/14/16`) tournent contre le compte preprod réel
- [ ] Spec 12 S7 valide une vraie checkout session (plus de tolérance 503)
