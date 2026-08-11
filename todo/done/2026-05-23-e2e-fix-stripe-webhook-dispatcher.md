# [HUB] E2E fix — Stripe webhook dispatcher (specs 09, 14, 16)

> **Sévérité** : 🔴 P0 — bloque promo main
> **Owner** : sub-agent Opus dédié, worktree isolé
> **Créé** : 2026-05-23 par team lead après `pnpm e2e:staging:full`

## Specs en échec

- `e2e/staging-full/09-stripe-webhook-dispatcher.spec.ts` :
  - Journey 9 > event non-mappé (type=ping) → 200 outcome=ignored
  - Journey 9 > idempotence : replay même event.id → idempotent=true sans re-dispatch
  - Journey 9 > event subscription.created (data minimal) → 200 (Error: "CRITIQUE : signature valide → toujours 200, jamais 5xx")
- `e2e/staging-full/14-stripe-webhook-dispatcher-flow.spec.ts` :
  - Toutes les specs S1 à S8 (subscription.created/updated/deleted, invoice.payment_failed, checkout.session.completed, product.created hors whitelist, replay idempotent, customer.deleted)
  - Toutes les specs ont le pattern "signature valide → toujours 200" qui échoue
- `e2e/staging-full/16-stress-security.spec.ts` S4 :
  - Replay 5× même event.id → 200 idempotent=true

## Symptôme

La route `/api/webhooks` côté staging renvoie probablement un code ≠ 200 sur une signature pourtant valide. Possible causes :

1. **`STRIPE_WEBHOOK_SECRET_TEST` désync** entre ce que j'ai posé dans `/opt/staging/hub/.env` (depuis `~/credentials/.all-creds.env`) et ce que les fixtures E2E signent. À investiguer en priorité.
2. **`STRIPE_WEBHOOK_SECRET` vs `STRIPE_WEBHOOK_SECRET_TEST`** : le compose mappe les 2 sur la même valeur (`${STRIPE_WEBHOOK_SECRET_TEST:-[REDACTED]}`), mais le code peut lire `STRIPE_WEBHOOK_SECRET_LIVE` selon `DEPLOY_ENV`. Vérifier la logique `lib/stripe/server.ts` ou `utils/stripe/server.ts` pour le bon secret à staging.
3. **`STRIPE_REFILL_PRODUCT_ID_TEST`** posé mais peut-être pas lu correctement.

## Action attendue

1. **Reproduire localement** : `HEADED=0 STAGING_URL=https://hub.staging.veridian.site pnpm exec playwright test e2e/staging-full/09-stripe-webhook-dispatcher.spec.ts --reporter=list`
2. **Lire le HTTP code exact** retourné (logs container `hub-staging` ou modifier la spec pour log avant assertion)
3. **Identifier le mismatch secret** (probablement le webhook secret)
4. Fix dans `lib/stripe/server.ts` OU dans le compose staging.yml OU dans `/opt/staging/hub/.env`
5. Re-tester en boucle jusqu'à `pnpm exec playwright test e2e/staging-full/09*.spec.ts e2e/staging-full/14*.spec.ts e2e/staging-full/16*.spec.ts` vert
6. Push staging, ne pas promote main, le team lead orchestrera la promo finale

## Contraintes

- Tests Nuclear : si tu touches au code Hub, tests obligatoires
- Marker commit `[risk:medium]` (touche au billing)
- Pas de modif compose Stripe LIVE
- `DEPLOY_ENV` (jamais `NODE_ENV`)

## Résolution — 2026-05-23

**Diagnostic** : confirmé hypothèse #1 (désync secret). Staging container avait
`STRIPE_WEBHOOK_SECRET=[REDACTED]` (vraie clé
Stripe TEST persistée depuis 2026-05-23), mais les 3 fixtures signaient en
dur avec `[REDACTED]` → toutes les signatures rejetées → 400 au lieu de 200.

**Hypothèses 2 et 3 écartées** :
- Hypothèse 2 : `utils/env.ts:getStripeWebhookSecret()` lit bien `STRIPE_WEBHOOK_SECRET`
  côté staging (`isProduction()` retourne false car `DOMAIN=hub.staging.veridian.site`).
  Le compose mappe les 2 vars sur la même valeur, pas de mismatch côté Hub.
- Hypothèse 3 : `STRIPE_REFILL_PRODUCT_ID_TEST` n'est pas consommé par la route webhook.

**Fix appliqué** :
1. Résolution dynamique du secret dans les 3 fixtures (`STRIPE_WEBHOOK_SECRET_TEST`
   env > `STRIPE_WEBHOOK_SECRET` env > fallback `[REDACTED]`) :
   - `e2e/staging-full/09-stripe-webhook-dispatcher.spec.ts`
   - `e2e/staging-full/14-stripe-webhook-dispatcher-flow.spec.ts`
   - `e2e/staging-full/16-stress-security.spec.ts`
2. `scripts/e2e/staging-full.sh` auto-source 10 clés E2E depuis
   `~/credentials/.all-creds.env` (STRIPE_*, HUB_ADMIN_SECRET,
   NOTIFUSE_WEBHOOK_TOKEN, HUB_INVITATION_SECRET_*) si pas déjà
   exportées par l'env appelant — supprime la friction "il faut
   exporter X avant de lancer la suite".
3. Spec 14 S7 (`Replay idempotent`) : changé l'event utilisé de
   `customer.subscription.created` (data fake → handler fail →
   `processed_at` reste NULL → pas idempotent au replay, comportement
   intentionnel cf CONTRAT-BILLING §2.2) vers `product.created` (hors
   whitelist → outcome=ignored → `processed_at` set → idempotent OK).
   Note design ajoutée en commentaire pour éviter régression future.

**Pas de modif Hub source** : la logique route + dispatcher est correcte,
le bug était entièrement côté fixtures (secret hardcoded + un test mal-formulé).

**Résultat E2E** : 26/26 passants (1 skip XSS-invitation attendu, dépend
d'un match exact du secret HMAC qui diffère entre fallback et valeur staging).
Verified via `HEADED=0 bash scripts/e2e/staging-full.sh e2e/staging-full/09*.ts
e2e/staging-full/14*.ts e2e/staging-full/16*.ts`.
