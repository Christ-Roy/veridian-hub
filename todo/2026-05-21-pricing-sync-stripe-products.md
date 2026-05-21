# [HUB] Pricing — synchroniser code + Stripe Dashboard avec PRICING-VERIDIAN.md

> **Type** : Sync doc ↔ code ↔ Stripe + provisioning Products/Prices Stripe
> **Sévérité** : 🔴 P1 — bloque la commercialisation SaaS réelle (Stripe webhook orchestrator est déployé mais aucun Price ID Stripe configuré → aucune session checkout possible)
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Refs** : `docs/PRICING-VERIDIAN.md` (source de vérité figée 2026-05-21 par Robert), memory `project_sprint_v14_complete_2026-05-21`

---

## Contexte

La **source de vérité pricing est figée** dans `docs/PRICING-VERIDIAN.md`
(pivot Robert 2026-05-21 — générosité maximale, 1 grille cross-app simple).

Mais le **code applicatif** dans `lib/pricing/plans.ts` représente un
modèle **pré-pivot** :
- 11 plans hétérogènes par app (`Notifuse Pro`, `Prospection Pro`, etc.)
- 18 occurrences `🚧 TODO_PRICE / TODO_STRIPE`
- TOUS les `stripePriceId` sont `null`

Et **Stripe Dashboard** côté `live` mode :
- Pas de Products configurés correspondant à la grille v1.4
- Pas de Prices créés
- Donc impossible de générer une `Stripe.checkout.session.create({ price: ... })` valide
- Le webhook orchestrator est PRÊT à recevoir des events Stripe mais aucun event ne peut être émis car il n'y a rien à souscrire.

**Résultat** : la commercialisation SaaS Veridian est en l'air. Le webhook
v1.4 fonctionne mais le funnel utilisateur ne peut pas générer une seule
souscription payante.

---

## Cible — état figé doc

D'après `docs/PRICING-VERIDIAN.md` :

| Plan | Prix mensuel | Prix annuel (par mois) | Public |
|---|---|---|---|
| **Free** | 0€ | 0€ | Trial 15j visible après J+2 + 5e mail |
| **Pro** | **29€** | ~24€ (-15%) | Tout illimité, paywall masqué |
| **Business** | **99€** | ~83€ (-15%) | + white-label custom (footer client) |
| **Enterprise** | custom | custom | On-demand contact sales |

**Important** : 1 seule grille cross-app — pas de plan par app. Un user paie **Pro 29€** pour avoir accès à TOUS les SaaS Veridian (Notifuse + Prospection + Analytics + CMS) dans son workspace.

Les plans actuels du code (`Notifuse Pro`, `Veridian Pro`, etc.) sont à
collapser en 4 plans cross-app.

---

## Actions à mener

### 1. Refondre `lib/pricing/plans.ts`

- Supprimer les 11 plans actuels
- Créer 3 plans cross-app : `pro`, `business`, `enterprise` (free n'a pas besoin de stripePriceId)
- Chaque plan a deux variantes mois/an : `stripePriceId: { month, year }`
- Définition des limites = "illimité" sauf branding et durée (cf doc)
- Helper `getPlanByPriceId(priceId)` pour le dispatcher Stripe webhook

### 2. Créer les Products + Prices Stripe (LIVE mode)

Via Stripe Dashboard ou Stripe CLI :

```bash
# Pro
stripe products create --name "Veridian Pro" --description "Tout illimité + branding optionnel"
stripe prices create --product=<prod_id> --currency=eur --recurring=interval=month --unit-amount=2900
stripe prices create --product=<prod_id> --currency=eur --recurring=interval=year --unit-amount=29000

# Business
stripe products create --name "Veridian Business" --description "Tout illimité + white-label custom"
stripe prices create --product=<prod_id> --currency=eur --recurring=interval=month --unit-amount=9900
stripe prices create --product=<prod_id> --currency=eur --recurring=interval=year --unit-amount=99000
```

Convention **metadata** Stripe (cf ticket stripe-webhook-orchestrator) :

```
Product metadata.veridian_plan: "pro" | "business" | "enterprise"
Subscription metadata.app: "hub" (1 sub Stripe = 1 workspace Hub cross-app)
Subscription metadata.tenant_id: "<hub_workspace_id>"
```

Pas de Product par app — c'est un seul Product cross-app par tier.

### 3. Faire la même chose en TEST mode pour staging

Stripe Test : créer les 2 mêmes Products avec les mêmes metadata, prix
en `--currency=eur`. Récupérer les `price_*` test IDs. Les injecter
côté Hub staging via env `STRIPE_PRICE_PRO_MONTH_TEST` etc. ou dans
`plans.ts` via fallback DEPLOY_ENV.

### 4. Câbler le dispatcher Stripe webhook au mapping plan

Aujourd'hui `lib/stripe/dispatcher.ts` reçoit l'event `customer.subscription.created` et lit `subscription.metadata.app`. Étendre pour :
- Lire `subscription.items[0].price.id` → résoudre le plan via `getPlanByPriceId`
- Appeler `notifuseClient.updatePlan(tenant_id, { plan: 'pro' | 'business', plan_source: 'stripe' })`
- Idem pour les autres apps (prospection, analytics, cms quand SaaS)

### 5. Créer la page `/pricing` qui affiche la vraie grille

Aujourd'hui `app/(marketing)/pricing/page.tsx` lit les Prisma `prices` (legacy). Refondre pour :
- Lire `lib/pricing/plans.ts` (source de vérité côté code)
- Toggle mois/an avec preview du -15% annuel
- Bouton "Démarrer Pro" → POST `/api/billing/checkout` qui crée une `checkout.session` avec le bon `priceId`
- Bouton "Démarrer Business" idem
- Bouton "Enterprise → Contact" qui ouvre un mailto ou form

### 6. Créer l'endpoint `/api/billing/checkout`

```typescript
POST /api/billing/checkout
Body: { plan: 'pro' | 'business', interval: 'month' | 'year' }
Auth: session Hub requise

Response: { url: 'https://checkout.stripe.com/...' } → frontend redirect
```

Côté code : récupérer `priceId` depuis `plans.ts`, créer Customer Stripe si nécessaire (lookup via `users.stripe_customer_id` puis backfill), créer `checkout.session.create` avec metadata.

### 7. Tests E2E flow billing complet

À ajouter dans `e2e/staging-full/` (probablement `10-billing-checkout-flow.spec.ts`) :
- Signup user → /pricing → click "Pro" → redirect Stripe Checkout test → fill carte test → retour app → vérifier subscription créée en DB Hub
- Re-check sur app downstream : tenant Notifuse plan=pro
- Test downgrade : annuler subscription via portal → webhook → tenant=free

Test seulement en TEST mode bien sûr (Stripe test cards : `4242 4242 4242 4242`).

### 8. Cohérence cross-app

Une fois fait :
- Notifuse doit lire le `plan_source=stripe` ET appliquer ses limites internes (pour l'instant illimité tout, cf doc)
- Prospection idem
- Analytics, CMS quand SaaS

Confirmer avec les agents Notifuse/Prospection que `update-plan { plan: 'pro' | 'business' }` est bien interprété et persisté côté app.

---

## Décisions à figer avec Robert

1. **Cycle de billing annuel** : -15% confirmé (29 × 12 × 0.85 = ~296€/an, soit 24,67€/mois). À valider.
2. **Stripe Customer = 1 user Hub** : 1 humain paie une fois pour tous les SaaS Veridian. Confirmé par doc, mais à valider Stripe Customer Portal config.
3. **Trial = 15 jours figés post-engagement** : cf ticket `2026-05-21-trial-state-machine.md`. Le webhook trial activé envoie `update-plan plan=pro plan_source=stripe_trial`. Confirmé.
4. **Plan "Enterprise" = quoi en pratique** : contact sales puis Robert crée un Product Stripe sur mesure ? Custom Price agreement ?
5. **Lifetime / Internal plans** dans le code actuel : à supprimer ou à conserver pour cas spéciaux (sites vitrines clients de Robert, partenaires) ?

---

## Plan d'attaque suggéré

1. **Aligner Robert sur les décisions ci-dessus** (1h, async)
2. **Refondre `lib/pricing/plans.ts`** : structure target + helper getPlanByPriceId (1h, agent peut faire avec source de vérité doc)
3. **Provisionner Products + Prices Stripe LIVE + TEST** (1h, manuel Stripe Dashboard ou CLI)
4. **Câbler dispatcher + endpoint checkout** (3h)
5. **Page /pricing refactor + E2E billing flow** (4h)
6. **Coordination apps downstream** (post-livraison, échange tickets cross-app)

Estimation totale : **~1 journée agent dédié + 1-2h de Robert pour les décisions et le provisioning Stripe Dashboard**.

---

## Dépendances

- **Bloque** : la commercialisation SaaS Veridian (aucun paiement possible aujourd'hui)
- **Débloque** : ticket `2026-05-21-trial-state-machine.md` (le state machine appelle `update-plan plan=pro plan_source=stripe_trial` — fonctionnera même sans Stripe Price ID, mais pour le path post-trial → upgrade payant il faut les Price IDs)
- **Débloque** : ticket UI `2026-05-21-ui-sprint-v14-suite.md #7` (page billing avec plans)
- **Lié à** : ticket dette tech `2026-05-21-dette-technique-audit-post-sprint-v14.md` #2

---

## DoD

- [ ] `lib/pricing/plans.ts` reflète la grille `docs/PRICING-VERIDIAN.md` (4 plans cross-app, pas 11 par app)
- [ ] 0 `🚧 TODO_PRICE / TODO_STRIPE` dans le code
- [ ] Products + Prices Stripe créés en LIVE et TEST modes avec metadata `veridian_plan`
- [ ] Endpoint `/api/billing/checkout` opérationnel
- [ ] Page `/pricing` affiche les vrais plans + toggle annuel
- [ ] E2E `10-billing-checkout-flow.spec.ts` passe sur staging avec Stripe test cards
- [ ] Webhook `customer.subscription.created` → `update-plan` côté Notifuse vérifié bout-en-bout
- [ ] Decision Robert sur "Enterprise" + "Lifetime/Internal" prise et appliquée
