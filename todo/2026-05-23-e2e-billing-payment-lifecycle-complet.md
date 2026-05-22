# [HUB] E2E billing — lifecycle paiement complet & robuste (cross-app)

> **Sévérité** : 🔴 P1 — bloquant avant ouverture commerciale large
> **Owner** : agent Hub (spec) + coordination agents Notifuse/Prospection
> **Créé** : 2026-05-23
> **Demandeur** : Robert — "des tests très robustes liés au paiement, avant et
>   après le checkout, que le tenant est bien avec son plan payant et n'a plus
>   de limite de temps"
> **Refs** :
> - Specs existantes (couverture partielle) :
>   `e2e/staging-full/09-stripe-webhook-dispatcher.spec.ts`,
>   `12-stripe-billing-flow.spec.ts`, `14-stripe-webhook-dispatcher-flow.spec.ts`,
>   `10-trial-state-machine-flow.spec.ts`
> - Tickets liés (ne pas dupliquer) :
>   `2026-05-22-ci-e2e-billing-preprod.md` (brancher CI sur Stripe preprod),
>   `2026-05-23-validate-dispatcher-first-customer.md` (monitoring 1er client),
>   `2026-05-22-endpoint-billing-state-reconciliation.md` (endpoint poll)
> - Contrat : `docs/CONTRAT-BILLING.md` v2.0

---

## 0. Pourquoi ce ticket

Les 4 specs existantes valident **chacune un morceau** : dispatcher, webhook,
catalogue, trial. **Mais aucune ne fait le scénario CLIENT COMPLET de bout en
bout** :
1. signup → trial → conversion paiement → plan actif → tenant débridé
2. cancellation → downgrade → tenant rebridé

C'est la garantie que Robert veut avant d'ouvrir aux vrais clients.

---

## 1. Scénarios E2E à livrer (Playwright staging — compte Stripe preprod)

> Dépend de `2026-05-22-ci-e2e-billing-preprod.md` (clés preprod en GH Secrets).
> Sans ça, ce ticket ne peut pas tourner — bloquant.

### 1.1 Happy path — signup → checkout → plan actif

```
ÉTAT INITIAL :
  - aucun user Hub existant pour test+lifecycle@veridian.site
  - aucun tenant Notifuse/Prospection associé

ÉTAPES :
  1. signup Hub (mock-oauth ou credentials)
  2. ASSERTIONS post-signup :
     - hub_app.users existe, supabaseUserId = UUID v4
     - hub_app.workspaces existe (auto-create au signup)
     - hub_app.tenants : 1 ligne Notifuse + 1 ligne Prospection, plan=free
     - tenant_trials : state=eligible (PAS active, cf flow trial 5 mails)
     - GET hub.staging.veridian.site/dashboard renvoie 200, plan free affiché
  3. clic /pricing → Notifuse Pro mensuel (price preprod) → Checkout Stripe
  4. complète paiement carte test 4242 4242 4242 4242
  5. Stripe redirige vers /dashboard?session_id=<sid>
  6. ASSERTIONS post-checkout (poll ~10s pour laisser webhook arriver) :
     - hub_app.stripe_events : event customer.subscription.created persisté
     - hub_app.users.stripeCustomerId rempli
     - hub_app.tenants Notifuse : veridianPlan = 'pro', planSource = 'stripe'
     - tenant_trials Notifuse : state = 'converted' (pas expired, pas active)
     - Notifuse downstream (DB notifuse-staging) : veridian_plan=pro,
       last_hub_sync_at récent
     - Hub /api/billing/state pour ce tenant renvoie plan=pro
     - audit_log : entry 'billing.checkout.completed'
```

### 1.2 Garantie "plus de limite de temps" — trial désactivé après paiement

```
ÉTAT INITIAL : user en trial actif (state=trial_active)
ÉTAPES : checkout Pro complété
ASSERTIONS :
  - tenant_trials.state passe à 'converted' (pas 'expired')
  - aucune notification d'expiration trial ne PART après la conversion
    (vérifier la file Notifuse — pas d'email "essai bientôt fini" envoyé)
  - le FreemiumBanner ne s'affiche plus côté UI dashboard
  - cron trial-tick ignore cet utilisateur (skip si converted)
```

### 1.3 Cancellation → downgrade auto

```
ÉTAT INITIAL : sub Notifuse Pro active, plan=pro
ÉTAPES :
  1. via Customer Portal Stripe (ou DELETE sub via API test) : cancel
  2. Stripe émet customer.subscription.deleted
ASSERTIONS :
  - hub_app.tenants.veridianPlan = 'free', planSource = 'downgrade_auto'
  - Notifuse downstream : veridian_plan=free, mode dégradé activé
  - audit_log : 'billing.subscription.canceled' + 'billing.downgrade.auto'
  - paywall Notifuse opérationnel : POST /api/messages renvoie 402
    avec error_code=plan_required (pas 500, pas auth fail)
  - mais READS restent OK (fail-open §3.4 CONTRAT-BILLING)
```

### 1.4 Bundle — Veridian Pro débridé sur 2 apps

```
checkout veridian-pro (49€/mo, bundle Notifuse+Prospection)
ASSERTIONS :
  - 2 tenants débridés simultanément (Notifuse + Prospection)
  - 1 seule subscription Stripe en source
  - Notifuse veridian_plan=pro
  - Prospection veridian_plan=pro
  - cancellation = les 2 downgradent ensemble
```

### 1.5 Paiement échoué — past_due, pas downgrade immédiat

```
ÉTAT INITIAL : sub Pro active
ÉTAPES :
  1. carte test 4000 0000 0000 0341 (declined sur prochain charge)
  2. attendre invoice.payment_failed
ASSERTIONS :
  - hub_app.tenants reste plan=pro (PAS de downgrade immédiat, §3.5 contrat)
  - tenant.metadata.dunning_state = 'past_due'
  - Telegram alert reçu (vérifier que TELEGRAM_BOT_TOKEN est en prod, cf
    ticket P1 2026-05-23-telegram-env-prod-hub.md)
  - email user envoyé via Notifuse (template dunning_payment_failed)
  - après N retries Stripe sans succès → customer.subscription.deleted →
    downgrade auto (= scénario 1.3)
```

### 1.6 Idempotence webhook (anti-replay)

```
ÉTAPES : Stripe retry un event customer.subscription.created 3× (même event_id)
ASSERTIONS :
  - hub_app.stripe_events n'a qu'UNE ligne pour cet event_id
  - tenant.veridianPlan n'a basculé qu'UNE fois en pro (pas de double dispatch)
  - audit_log : 1 seule entry de conversion, les 2 autres en 'duplicate_ignored'
```

### 1.7 Plan offert — immune au webhook (anti-régression §3.3 contrat)

```
ÉTAT INITIAL : user avec planSource='grant_manual' (lifetime-site-vitrine)
ÉTAPES : Stripe émet artificiellement update-plan plan=free plan_source=downgrade_auto
ASSERTIONS :
  - tenant.veridianPlan reste 'pro' (grant_manual immune, §3.3.1)
  - audit_log : 'billing.downgrade.skipped.grant_manual_immunity'
  - aucun update-plan ne part vers downstream
```

---

## 2. Tests unitaires Vitest supplémentaires (couverture)

Au-delà des E2E, garantir au niveau unit :

### 2.1 Dispatcher Hub — `lib/stripe/dispatcher.ts`
- ✅ test : 1 event → 1 update-plan dispatché par app cible
- ❌ MANQUE : event sur Price hors catalogue (LEGACY_STRIPE_PRICE_MAPPING) → fallback propre, pas crash, Telegram alerté
- ❌ MANQUE : tenant introuvable par stripe_customer_id → fail-safe (cf gap trouvé pendant validation 22-05)
- ❌ MANQUE : HMAC update-plan signature côté app downstream → vrai test du contrat HMAC, pas un mock superficiel

### 2.2 Resolver plan↔apps
- ✅ price → plan (existe)
- ❌ MANQUE : plan → liste d'apps cibles (notifuse-pro → [notifuse], veridian-pro → [notifuse, prospection])
- ❌ MANQUE : enum plan_source strict (rejet de toute valeur hors {stripe, stripe_trial, grant_manual, downgrade_auto})

### 2.3 Fail-open downstream
- ❌ MANQUE : app downstream HS (timeout, 503) → Hub NE downgrade PAS le tenant local, reste plan actuel jusqu'au prochain push
- ❌ MANQUE : update-plan répété (retry) avec idempotency_key identique → app ignore le doublon

---

## 3. Tests d'intégration cross-app (côté apps downstream)

À déposer en tickets dans `notifuse-veridian/todo/` et `veridian-prospection/todo/` :

### 3.1 Notifuse — `/api/tenants/update-plan` consumer
- payload `update-plan` HMAC valide → tenant `veridian_plan` mis à jour
- HMAC invalide → 401 sans modification
- plan_source enum fermé → 400 si valeur hors enum
- idempotence sur `idempotency_key` (fenêtre 24h)
- downgrade `plan_source=downgrade_auto` → active le mode dégradé paywall
  (writes 402, reads OK)

### 3.2 Prospection — idem + spécifique
- même contrat que Notifuse
- spécifique : welcome leads grant au passage trial→paid (ticket
  `2026-05-22-call-credit-leads-welcome-at-provisioning.md`)
- refill leads (one-shot Stripe Checkout) — couvert par ticket
  `2026-05-22-refill-leads-stripe-checkout-oneshot.md`

---

## 4. Garde-fous monitoring (run-time, pas test)

Tests = sécurité PRÉ-livraison. Monitoring = sécurité EN-livraison. À câbler :

### 4.1 Alerting Telegram (cf ticket P1 2026-05-23-telegram-env-prod-hub.md)
- webhook signature invalide → alerte
- dispatcher failed (customer introuvable, app downstream HS, plan inconnu) → alerte
- past_due détecté → alerte

### 4.2 Dashboard Grafana ou métriques minimales
- compteur webhooks Stripe reçus/heure (proxy santé)
- compteur dispatches OK / dispatches failed
- compteur subs actives par plan (proxy revenu)
- âge max d'un past_due (si > 7j sans résolution → ticket support)

### 4.3 Checks périodiques (cron)
- toutes les heures : `hub_app.stripe_events` count where status=failed in last 24h → si > 0 alerte
- tous les jours : audit cohérence `tenant.veridianPlan` vs Stripe subscription status (drift detection)

---

## 5. Plan d'attaque

Ordre suggéré, vu les dépendances :

1. **Prérequis bloquant** : ticket `2026-05-22-ci-e2e-billing-preprod.md` livré (clés preprod en CI) — sans ça, aucun E2E n'a un Stripe réel à taper.
2. **Bloc 1** (§1) : écrire les 7 scénarios E2E. Réutiliser les helpers des 4 specs billing existantes. Estimation : 1-2j agent.
3. **Bloc 2** (§2) : compléter les unit tests dispatcher. Estimation : 0.5j.
4. **Bloc 3** (§3) : déposer les tickets cross-app, attendre les agents Notifuse/Prospection.
5. **Bloc 4** (§4) : monitoring — peut tourner en parallèle, indépendant.

---

## 6. DoD

- [ ] 7 scénarios E2E §1 tous verts en CI staging sur compte Stripe preprod
- [ ] Unit tests dispatcher §2 : couverture 100% des 6 gaps identifiés
- [ ] Tickets §3 déposés et trackés côté apps downstream
- [ ] Monitoring Telegram §4.1 actif (suit le ticket P1 ENV Telegram)
- [ ] Au moins 1 cron de drift detection §4.3 actif
- [ ] Documentation runbook : "que faire si un client appelle en disant
      'j'ai payé mais ma limite est toujours là'" — checklist d'investigation
