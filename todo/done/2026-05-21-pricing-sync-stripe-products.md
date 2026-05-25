# [HUB] Brancher Stripe — checkout + catalogue complet

> **Sévérité** : 🔴 P0 — débloque la commercialisation. Sprint "vitesse grand V".
> **Owner** : agent Hub
> **Créé** : 2026-05-21 — réécrit 2026-05-22 en brief d'exécution
> **Pré-requis** : `2026-05-22-stripe-dashboard-prerequis.md` doit être DONE
>   (compte nettoyé, webhook Hub réactivé, Stripe Tax activé)
> **Sources** : `docs/PRICING-VERIDIAN.md` v1.1, `docs/CONTRAT-BILLING.md` v2.0,
>   `veridian-infra/shared/pricing/plans.ts` (catalogue canonique)

---

## DÉCISIONS ROBERT FIGÉES (2026-05-22) — ne pas re-demander

1. **Stripe Tax = ACTIVÉ** — TVA collectée auto par Stripe selon pays client.
   `checkout.sessions.create` doit passer `automatic_tax: { enabled: true }`.
2. **Catalogue = COMPLET** — les 5 produits vendables + 2 bundles d'un coup.
3. **Perks annuels (onboarding/support prioritaire/calendar) = HORS SCOPE.**
   Reporté → `todo/2026-05-22-perks-annuels-onboarding.md` (P5). Ce sprint NE
   câble PAS `triggerAnnualPerks`, NI le template MJML annuel, NI le calendar.
   Le flag `annualPerks` n'est pas implémenté ici.
4. **Compte Stripe** : `acct_1SRJNzRgvfRggzUN`, FR/EUR, charges+payouts OK.

---

## CE QU'ON LIVRE (4 blocs)

### BLOC 1 — Catalogue `plans.ts` + provisioning Stripe

**1a. Refondre le pricing** (cf `shared/pricing/plans.ts`, grille v1.1) — 8 plans :

| PlanKey | Mensuel | Annuel/mo | Stripe ? |
|---|---|---|---|
| `notifuse-free` | 0€ | — | non |
| `notifuse-pro` | 29€ | 24€ | oui |
| `notifuse-business` | 99€ | 82€ | oui |
| `prospection-free` | 0€ | — | non |
| `prospection-pro` | 29€ | 24€ | oui |
| `prospection-business` | 89€ | 74€ | oui |
| `veridian-pro` (bundle) | 49€ | 41€ | oui |
| `veridian-business` (bundle) | 149€ | 124€ | oui |

→ 5 produits payants × 2 intervalles (month/year) = **10 Prices LIVE + 10 TEST**.
Annuel = -17% (≈ 10 mois payés sur 12).
Plans offerts (`lifetime-*`, `internal`) : pas de Stripe, immunes au webhook.

**1b. Script de provisioning** `scripts/admin/setup-stripe-prices.ts` :
- Lit `shared/pricing/plans.ts`, crée Products + Prices via API Stripe.
- Convention metadata OBLIGATOIRE :
  - `Product.metadata.veridian_plan` = la PlanKey (ex `notifuse-pro`)
  - `Price.metadata.interval` = `month` | `year`
- Tourne en LIVE et en TEST (clés `STRIPE_*_LIVE` / `STRIPE_*_TEST` des creds).
- Écrit les IDs retournés dans `shared/pricing/plans.ts` :
  `stripePriceIdLive: {month, year}` + `stripePriceIdTest: {month, year}`.
- Idempotent : si un Product `veridian_plan=X` existe déjà, le réutiliser.
- ⚠️ Créer des Products = tier 💀. L'agent prépare le script, le fait
  tourner en TEST d'abord (vérif), puis demande le GO Robert avant le run LIVE.

### BLOC 2 — Endpoint checkout

`POST /api/billing/checkout` (le fichier `app/api/billing/checkout/route.ts`
existe déjà en squelette — le compléter) :
- Auth : session Hub.
- Body : `{ plan: PlanKey, interval: 'month'|'year' }`, validé Zod.
- Logique : récupère user → `users.stripe_customer_id` (crée le Customer si
  null) → résout le Price via `getStripePriceId(plan, interval, env)` →
  `stripe.checkout.sessions.create({ customer, line_items:[{price,quantity:1}],
  mode:'subscription', automatic_tax:{enabled:true},
  metadata:{ veridian_plan, app, tenant_id }, success_url, cancel_url })`.
- Retourne `{ url }`. Rate-limit (pattern existant).

### BLOC 3 — Dispatcher webhook → update-plan

`lib/stripe/dispatcher.ts` (le webhook orchestrator existe, en prod). Étendre
les handlers pour mapper Stripe → apps, conforme `CONTRAT-BILLING.md` v2.0 :
- `checkout.session.completed` / `customer.subscription.created` / `.updated` :
  résoudre le plan via `Price.metadata.veridian_plan`, déterminer les apps
  cibles (`appsUnlocked` — un bundle touche 2 apps), appeler
  `<app>/api/tenants/update-plan` en HMAC avec `plan_source: 'stripe'`.
- `customer.subscription.deleted` → `update-plan plan=free plan_source=downgrade_auto`.
- `invoice.payment_failed` → Hub gère le dunning, tenant reste actif (cf
  CONTRAT-BILLING §3.5). Pas de downgrade immédiat.
- Idempotence sur `event.id` (table `stripe_events`, déjà en place).
- Helper `getPlanByPriceId(priceId)` dans `plans.ts`.

### BLOC 4 — Page `/pricing` + checkout UI

`app/(marketing)/pricing/page.tsx` :
- Lire `shared/pricing/plans.ts` (plus les `prices` Prisma legacy).
- Toggle mensuel/annuel (preview -17%).
- Bouton par plan payant → `POST /api/billing/checkout` → redirect `session.url`.
- Bundles dans une section séparée. Enterprise → contact.
- JSON-LD SEO avec les vrais prix.

---

## TESTS (Mode Nuclear — obligatoire)

Unit (vitest) :
- `plans.test.ts` : cohérence bundles (veridian-pro = (notifuse-pro+prospection-pro)×0.85 ; veridian-business ×0.80).
- `getPlanByPriceId.test.ts` : resolver.
- `checkout.test.ts` : endpoint — lookup/création customer, résolution priceId, `automatic_tax` présent, retour URL.
- `dispatcher.test.ts` : mapping price→plan→apps, bundle touche 2 apps, idempotence event.id.

E2E (Playwright staging) — `e2e/staging-full/billing-checkout-flow.spec.ts` :
1. Signup → `/pricing` → click "Pro" mensuel → Stripe Checkout TEST (carte 4242 4242 4242 4242).
2. Retour app → DB Hub : subscription créée + `update-plan` reçu côté app (plan=pro).
3. Cancel via Customer Portal → webhook → tenant downgraded `free`.
4. Test bundle : checkout `veridian-pro` → vérifier que Notifuse ET Prospection passent `pro`.

---

## ORDRE D'EXÉCUTION

```
0. Vérifier que 2026-05-22-stripe-dashboard-prerequis.md est DONE (sinon STOP)
1. BLOC 1a — refondre plans.ts (catalogue v1.1)
2. BLOC 1b — script provisioning → run TEST → vérif → GO Robert → run LIVE
3. BLOC 2 — endpoint checkout
4. BLOC 3 — dispatcher
5. BLOC 4 — page pricing
6. Tests unit + E2E staging avec cartes test
7. QA + push staging → CI → promotion (tier 💀 sur le run LIVE Stripe → go Robert)
```

---

## GARDE-FOUS

- Le run **LIVE** du script de provisioning = tier 💀 (crée des produits de
  vente réels) → GO explicite Robert avant. Le run TEST = libre.
- `automatic_tax: { enabled: true }` sur TOUTE création de checkout session.
- Conforme `CONTRAT-BILLING.md` v2.0 : payload `update-plan` versionné,
  `plan_source` enum fermé, fail-open.
- Plans offerts immunes — le dispatcher ne les touche jamais.
- Mode Nuclear : tout fichier business = test.

---

## DoD

- [ ] `shared/pricing/plans.ts` = grille v1.1, `stripePriceIdLive`+`Test` remplis
- [ ] Script `setup-stripe-prices.ts` livré, idempotent, run TEST + LIVE OK
- [ ] 5 Products + 10 Prices LIVE + 10 TEST créés, metadata `veridian_plan`+`interval`
- [ ] `POST /api/billing/checkout` opérationnel avec `automatic_tax`
- [ ] Dispatcher mappe price→plan→apps (bundle = 2 apps), idempotent
- [ ] Page `/pricing` = vrais plans, toggle annuel, boutons checkout
- [ ] E2E billing-checkout-flow vert sur staging (carte test)
- [ ] CI verte, promu en prod
