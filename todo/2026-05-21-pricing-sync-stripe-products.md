# [HUB] Pricing — synchroniser code + Stripe Dashboard + valeur ajoutée annuelle

> **Type** : Sync code ↔ Stripe + provisioning Products/Prices + automations annuel
> **Sévérité** : 🔴 P1 — bloque la commercialisation SaaS réelle
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Source de vérité** : `docs/PRICING-VERIDIAN.md` v1.1 (consolidée 2026-05-21 soir)
> **Refs** :
> - `veridian-prospection/todo/2026-05-21-business-plan-pricing-features.md` (business plan complet)
> - `veridian-hub/todo/2026-05-21-align-prospection-pricing-from-prosp-session.md` (ticket alignement déjà posé)

---

## Contexte

`docs/PRICING-VERIDIAN.md` v1.1 = source de vérité figée. **Mais** :
- `lib/pricing/plans.ts` = 11 plans pré-pivot avec 18 `🚧 TODO_PRICE / TODO_STRIPE`, tous `stripePriceId: null`
- Stripe Dashboard LIVE = aucun Product/Price provisionné
- Webhook orchestrator déployé en prod mais aucune session checkout possible → **commercialisation bloquée**

Le ticket `2026-05-21-align-prospection-pricing-from-prosp-session.md` a déjà documenté les changements `plans.ts` à faire — ce ticket-ci consolide TOUT le flow checkout + Stripe + annuel.

---

## Cible code `lib/pricing/plans.ts`

8 plans à définir (vs 11 actuels) :

### Notifuse (3 plans)

| PlanKey | Mensuel | Annuel/mo | Notes |
|---|---|---|---|
| `notifuse-free` | 0€ | — | Trial 15j visible après J+2 + 5e mail |
| `notifuse-pro` | **29€** | **24€** (290€/an) | Tout illimité, branding optionnel |
| `notifuse-business` | **99€** | **82€** (990€/an) | + white-label custom |

(`notifuse-enterprise` : sur devis hors plans.ts pour l'instant)

### Prospection (3 plans)

| PlanKey | Mensuel | Annuel/mo | Welcome leads | Seats |
|---|---|---|---|---|
| `prospection-free` (renommer `prospection-freemium`) | 0€ | — | 100 | illimité (workspaces séparés) |
| `prospection-pro` | **29€** | **24€** | 2 000 | 5 |
| `prospection-business` (renommer depuis `prospection-enterprise`) | **89€** | **74€** | 8 000 | 25 |

**Refill leads** : tarifs `LEAD_REFILL_PRICING` cf doc + déjà câblé dans `veridian-prospection/src/lib/billing/plans.ts`. Côté Hub on n'a qu'à propager les `stripePriceId` du Stripe Checkout one-shot par tranche (non récurrent).

### Bundles cross-app (2 plans)

| PlanKey | Mensuel | Annuel/mo | Composition | Économie |
|---|---|---|---|---|
| `veridian-pro` | **49€** | **41€** | notifuse-pro + prospection-pro | -15% (58€ → 49€) |
| `veridian-business` | **149€** | **124€** | notifuse-business + prospection-business | -20% (188€ → 149€) |

### Plans offerts (3 plans, pas de Stripe Product associé)

| PlanKey | Équivalent | Géré par |
|---|---|---|
| `lifetime-site-vitrine` | Veridian Pro à vie | `POST /api/admin/grant-unlimited` |
| `lifetime-partner` | Veridian Business à vie | idem |
| `internal` | Enterprise illimité | idem |

Pas de `stripePriceId` (null). Le dispatcher webhook Stripe **ne touche pas** ces plans (immunes au downgrade).

---

## Actions à mener

### 1. Refondre `lib/pricing/plans.ts`

Le ticket `2026-05-21-align-prospection-pricing-from-prosp-session.md` détaille déjà les modifications PlanKey par PlanKey. **Le réutiliser tel quel** + intégrer le flag annuel = `support_priority + onboarding_session + premium_tutos` (cf §3 ci-dessous).

Ajouter type/champ :

```typescript
export interface Plan {
  // ... existing
  /** Si true (plan annuel), inclut support prioritaire + onboarding
   *  accompagné + accès tutos avancés. Lu par l'event webhook
   *  `customer.subscription.created` pour déclencher les automations. */
  annualPerks?: {
    supportPriority: boolean;
    onboardingSession: boolean;
    premiumTutos: boolean;
  };
}
```

### 2. Provisionner Products + Prices Stripe LIVE

Via Stripe Dashboard (ou Stripe CLI). Convention metadata :

```
Product.metadata.veridian_plan = "notifuse-pro" | "veridian-business" | etc.
Price.metadata.interval = "month" | "year"
Price.metadata.is_annual_perks = "true" si Price.interval=year (pour le webhook handler)

Subscription.metadata.app = "notifuse" | "prospection" | "bundle"
Subscription.metadata.tenant_id = "<hub_workspace_id>"
```

**8 Products à créer** (5 Stripe Subs + 3 sans Stripe pour les offerts) :
- Notifuse Free (pas de Stripe, plan gratuit)
- Notifuse Pro → 2 Prices (month + year)
- Notifuse Business → 2 Prices
- Prospection Freemium (pas de Stripe)
- Prospection Pro → 2 Prices
- Prospection Business → 2 Prices
- Veridian Pro Bundle → 2 Prices
- Veridian Business Bundle → 2 Prices

Total : **5 Products avec Stripe Subscriptions × 2 intervals = 10 Stripe Prices LIVE**.

+ Refill leads Prospection : 3 plans × 5 tranches = jusqu'à 15 Prices Stripe one-shot (peuvent être créés en lazy quand l'agent prosp livre son flow Checkout refill — pas bloquant ce ticket).

### 3. Provisionner Products + Prices Stripe TEST (pour staging E2E)

Idem en TEST mode : mêmes metadata, prix `--currency=eur`. Récupérer les IDs `price_test_*` et les coller dans `plans.ts` via fallback `DEPLOY_ENV !== 'production' ? stripeTestPriceId : stripeLivePriceId`.

Plus simple : 2 champs séparés `stripePriceIdLive` et `stripePriceIdTest`, helper `getStripePriceId(plan, interval, env)` qui résout.

### 4. Câbler dispatcher Stripe webhook au mapping plan + annuel

`lib/stripe/dispatcher.ts` aujourd'hui appelle `manageSubscriptionStatusChange` mais ne propage pas le plan ni l'interval. Étendre :

```typescript
case 'customer.subscription.created':
case 'customer.subscription.updated': {
  const sub = event.data.object as Stripe.Subscription;
  const priceId = sub.items.data[0]?.price.id;
  const plan = getPlanByPriceId(priceId); // helper plans.ts
  const interval = sub.items.data[0]?.price.recurring?.interval; // 'month' | 'year'
  const isAnnual = interval === 'year';

  // Apps concernées (1 plan peut toucher 1 ou 2 apps si bundle)
  const targetApps = plan.appsUnlocked; // ['notifuse'] ou ['notifuse','prospection']

  for (const app of targetApps) {
    await callDownstreamUpdatePlan(app, sub.metadata.tenant_id, {
      plan: plan.tier, // 'pro' | 'business'
      plan_source: 'stripe',
    });
  }

  // Si annuel : déclencher les automations valeur ajoutée
  if (isAnnual && plan.annualPerks) {
    await triggerAnnualPerks(sub.customer, sub.metadata.tenant_id, plan);
  }
}
```

`triggerAnnualPerks(customerId, tenantId, plan)` doit (cf §6 ci-dessous) :
1. Créer le tag user `veridian_annual=true` dans `hub_app.users.metadata`
2. Envoyer le mail de bienvenue annuel avec calendar booking
3. Notifier Robert via Telegram + créer un thread support prioritaire (canal helpdesk à définir)

### 5. Créer l'endpoint `/api/billing/checkout`

```typescript
POST /api/billing/checkout
Auth: session Hub
Body: { plan: PlanKey, interval: 'month' | 'year' }
Response: { url: 'https://checkout.stripe.com/...' }
```

Logique :
1. Récupère le user session
2. Lookup `users.stripe_customer_id` → si null, crée le Customer Stripe
3. Récupère `stripePriceId` via `getStripePriceId(plan, interval, env)`
4. Appelle `stripe.checkout.sessions.create({ customer, line_items: [{price, quantity:1}], mode: 'subscription', metadata: { app, tenant_id }, success_url, cancel_url })`
5. Retourne `session.url`

### 6. Automations valeur ajoutée annuelle

Nouvelle lib `lib/annual-perks/` avec :

#### a. `triggerAnnualPerks.ts`

```typescript
export async function triggerAnnualPerks(
  stripeCustomerId: string,
  tenantId: string,
  plan: Plan,
): Promise<void> {
  // 1. Tag user
  await prisma.user.update({
    where: { stripeCustomerId },
    data: {
      metadata: {
        path: ['$.veridian_annual'],
        set: true,
      },
    },
  });

  // 2. Mail bienvenue annuel + calendar
  await notifuseClient.sendEmail({
    template: 'veridian-annual-welcome',
    to: user.email,
    variables: {
      plan_name: plan.name,
      calendar_link: ANNUAL_CALENDAR_LINK, // Cal.com / Calendly ENV
      tutos_link: 'https://app.veridian.site/learn/annual',
    },
  });

  // 3. Notif Robert
  await sendTelegramAlert(
    `🎉 Nouveau client annuel : ${user.email} sur ${plan.name}\n` +
    `Calendar booking attendu sous 7j.`,
  );

  // 4. Créer un thread support (si stack support intégrée — à définir)
  //    Pour V1 : juste un audit_log entry "annual_perks_triggered"
  await writeAuditLog({
    action: 'annual_perks.triggered',
    actor: 'system:stripe-webhook',
    targetType: 'user',
    targetId: user.id,
    payload: { plan: plan.id, calendar_link_sent: true },
  });
}
```

#### b. Template MJML `veridian-annual-welcome`

À créer via skill `notifuse-templates` :
- Header logo + "Bienvenue dans la formule annuelle Veridian"
- Body : merci, voici ce qui est inclus en annuel (support priority < 24h, onboarding 30-60min visio, tutos avancés)
- CTA primaire : "Réserver mon onboarding" → lien calendar
- CTA secondaire : "Accéder aux tutos" → URL
- Footer : signature Robert + email support direct

#### c. ENV à provisionner

```
ANNUAL_CALENDAR_LINK=https://cal.com/robert-veridian/onboarding-30min
ANNUAL_SUPPORT_CHANNEL=helpdesk@veridian.site (ou Lark group ID)
```

À mettre dans `.env.example` + Dokploy compose Hub.

### 7. Page `/pricing` refactor

`app/(marketing)/pricing/page.tsx` aujourd'hui lit les Prisma `prices` (legacy). Refondre pour :
- Lire `lib/pricing/plans.ts` (source de vérité code)
- Toggle mensuel/annuel avec preview du -17% annuel
- Badge "annuel inclus : support prioritaire + onboarding + tutos"
- Bouton "Démarrer Pro" → `POST /api/billing/checkout` + redirect Stripe
- Bouton "Démarrer Business" idem
- Section bundles cross-app séparée
- "Enterprise → Contact" mailto ou form

JSON-LD SEO avec les vrais prix (déjà câblé partiellement, à updater).

### 8. Tests

#### Tests unit (vitest)

- `__tests__/lib/pricing/plans.test.ts` : cohérence bundles (Veridian Pro = somme × 0.85, Business = somme × 0.80)
- `__tests__/lib/pricing/getPlanByPriceId.test.ts` : helper resolver
- `__tests__/lib/annual-perks/trigger.test.ts` : automations annuel (mock prisma + notifuse + telegram)
- `__tests__/api/billing/checkout.test.ts` : endpoint POST, lookup customer, lookup priceId, retour URL

#### Tests E2E (Playwright staging)

Nouveau spec `e2e/staging-full/10-billing-checkout-flow.spec.ts` :
1. Signup user → /pricing visible
2. Click "Pro" mensuel → redirect Stripe Checkout test (4242 4242 4242 4242)
3. Retour app → DB Hub : subscription créée + plan Notifuse passé en `pro`
4. Click "Pro" annuel → vérifier en plus `veridian_annual=true` + audit_log `annual_perks.triggered`
5. Test downgrade : cancel subscription via portal → webhook → tenant downgraded à `free`

### 9. Coordination cross-app

Une fois `update-plan` reçu côté Notifuse / Prospection :
- Notifuse stocke `plan: 'pro' | 'business'` dans `tenant.veridian_plan` (déjà câblé via V37)
- Prospection idem (déjà câblé)
- Confirmer avec les agents apps que `plan_source=stripe` les fait basculer en mode "real billing" (pas trial)

---

## Décisions déjà figées (cf doc v1.1)

- ✅ Annuel = **-17%** sur le mensuel (calculé sur 12 mois ≈ 10 mois)
- ✅ 1 Stripe Customer = 1 user Hub (même user peut souscrire bundle ou plans séparés)
- ✅ Bundle = 1 Subscription unique qui débloque 2 apps via dispatcher
- ✅ Plans offerts (`lifetime-*`, `internal`) ne sont jamais touchés par Stripe webhook (immunes)
- ✅ Annuel inclut support prioritaire + onboarding accompagné 30-60min + tutos avancés
- ✅ "Enterprise" Notifuse = sur devis hors plans.ts pour l'instant
- ✅ Refill leads Prospection = Stripe Checkout one-shot par tranche (pas metered, pas wallet)

---

## Décisions à figer avec Robert (avant exécution)

1. **Stack Cal.com vs Calendly** pour le calendar booking annuel — choix maintenant pour cabler l'URL.
2. **Stack support prioritaire** : créer un thread dans Lark / Slack / email helpdesk@ ? Pour V1 juste un audit_log + email suffit, mais à définir la cible long terme.
3. **Template MJML annuel** : doit être validé visuellement (preview MJML rendu) avant envoi à de vrais clients.
4. **Stripe Customer Portal** : config à activer côté Stripe Dashboard pour permettre cancel/update CB depuis l'app sans dev custom.

---

## Plan d'attaque suggéré

1. Robert valide les 4 décisions ci-dessus (15 min async)
2. Agent provisionne Products + Prices Stripe LIVE + TEST (1h manuel ou via `scripts/admin/setup-stripe-prices.ts` à créer)
3. Agent refond `lib/pricing/plans.ts` + tests bundles cohérence (1h)
4. Agent câble dispatcher au mapping plan + endpoint `/api/billing/checkout` (3h)
5. Agent implémente `lib/annual-perks/triggerAnnualPerks` + template MJML (2h)
6. Agent refond page `/pricing` (2h)
7. Agent écrit E2E billing flow staging avec Stripe test cards (2h)
8. Coordination avec agents Notifuse/Prospection pour valider `update-plan` reçu OK (1h, async via tickets)

**Estimation totale : ~1.5 jour agent dédié + 15-30 min Robert pour les décisions et le Stripe Dashboard.**

---

## Dépendances

**Bloque** :
- Commercialisation SaaS Veridian (aucun paiement possible aujourd'hui)
- Ticket `2026-05-21-trial-state-machine.md` (state machine appelle `update-plan plan=pro plan_source=stripe_trial` — fonctionnera tel quel, mais pour le path post-trial → upgrade payant il faut les Price IDs)
- Ticket UI `2026-05-21-ui-sprint-v14-suite.md #7` (page billing avec plans)

**Lié à** :
- `2026-05-21-align-prospection-pricing-from-prosp-session.md` (qui a posé les modifs `plans.ts` détaillées — ce ticket-ci l'absorbe et l'étend avec Stripe + annuel)
- Ticket dette tech `2026-05-21-dette-technique-audit-post-sprint-v14.md` #2 (qui pointait juste les TODO_PRICE — ce ticket-ci les résout)

---

## DoD

- [ ] `lib/pricing/plans.ts` reflète la grille v1.1 (8 plans, 0 TODO_PRICE/STRIPE)
- [ ] Type `Plan.annualPerks` ajouté
- [ ] Products + Prices Stripe créés LIVE et TEST avec metadata `veridian_plan` + `interval`
- [ ] Endpoint `/api/billing/checkout` opérationnel
- [ ] `lib/annual-perks/triggerAnnualPerks` opérationnel (tag user + mail + Telegram + audit_log)
- [ ] Template MJML `veridian-annual-welcome` livré
- [ ] Page `/pricing` affiche les vrais plans + toggle annuel + badge perks
- [ ] E2E `10-billing-checkout-flow.spec.ts` passe sur staging avec Stripe test cards
- [ ] Webhook `customer.subscription.created` annuel → `triggerAnnualPerks` vérifié bout-en-bout
- [ ] Stripe Customer Portal activé Dashboard (cancel/update CB en self-service)
- [ ] Décisions Robert prises : Cal.com vs Calendly, stack support prioritaire
