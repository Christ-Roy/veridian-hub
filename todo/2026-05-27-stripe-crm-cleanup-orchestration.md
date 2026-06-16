# Stripe CRM — cleanup ad-hoc + orchestration propre Hub→Twenty

> **Sévérité** : 🟡 P1 (dette technique post-déploiement CRM en prod, fonctionne mais shortcuts SQL ad-hoc)
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27 par agent veridian-crm post-déploiement
> **Contexte** : Veridian CRM (fork Twenty) live en prod sur `crm.app.veridian.site` avec `IS_BILLING_ENABLED=true` + Stripe LIVE. Mais des hacks SQL ad-hoc ont été posés pour débloquer Robert (admin). À industrialiser maintenant que le pattern marche.

## TL;DR

Le billing Twenty natif est **actif en prod** avec Stripe LIVE. Le webhook Stripe → Twenty marche. Les 4 Products Stripe + Prices + Meter sont synced en DB Twenty. **MAIS** :

1. Le compte admin Robert (`robert.brunon@veridian.site`) a une Subscription Stripe gratuite (coupon 100% off forever) **insérée manuellement en DB Twenty via SQL** parce que Twenty ne propose pas de mutation native "free admin access".
2. Aucune route Hub n'orchestre le flow signup→checkout→tenant pour les **vrais clients** mass market.
3. Le webhook Stripe → Twenty fonctionne mais ne tagge pas correctement les workspaces côté metadata (Twenty s'attend à initier le checkout lui-même).

## État actuel — ce qui marche déjà

### Infra Twenty CRM prod (admin-twenty skill garde la mémoire)

- URL : `https://crm.app.veridian.site`
- Container : `compose-parse-optical-array-lvh5md-crm-server-1`
- DB : Postgres avec 7 tables `core.billing*` créées via TypeORM migration
- Stripe : LIVE (`sk_live_51SRJNz...`)
- Webhook Stripe → Twenty : `we_1Tbi7mRgvfRggzUNIsLDJmBp` actif, 16 events, secret `whsec_AeMD6tdz...`

### Products Stripe LIVE taggés Twenty

| Product | ID Stripe | Metadata Twenty |
|---|---|---|
| Veridian Pro | `prod_UZ3ztbggHNj9wq` | `planKey=PRO, productKey=BASE_PRODUCT, priceUsageBased=LICENSED` |
| Veridian Business | `prod_UZ3zmqPhKq6Qyi` | `planKey=ENTERPRISE, productKey=BASE_PRODUCT, priceUsageBased=LICENSED` |
| Workflow Credits Pro | `prod_UatnMplFLzYHaw` | `planKey=PRO, productKey=RESOURCE_CREDIT, priceUsageBased=METERED` |
| Workflow Credits Enterprise | `prod_UatnyL5NHb1BZk` | `planKey=ENTERPRISE, productKey=RESOURCE_CREDIT, priceUsageBased=METERED` |

### Prices Stripe LIVE

| Plan | Price ID | Tarif |
|---|---|---|
| Pro mensuel | `price_1TZvr9RgvfRggzUNEsd2oIZ5` | 49€/mois |
| Pro annuel | `price_1TZvr9RgvfRggzUN9rjh3F6W` | 492€/an |
| Business mensuel | `price_1TZvrARgvfRggzUNR0eEqD57` | 149€/mois |
| Business annuel | `price_1TZvrBRgvfRggzUNdVsA3kyc` | 1488€/an |
| Workflow Credits Pro metered | `price_1Tbi0eRgvfRggzUNzIx7GKnL` | 0.01€/credit |
| Workflow Credits Enterprise metered | `price_1Tbi0eRgvfRggzUNb8u3m1FE` | 0.008€/credit |

### Coupon de référence

`ROBERT_ADMIN_FREE_FOREVER` — 100% off forever, déjà créé côté Stripe LIVE.

### Stripe Billing Meter

`mtr_61Ul5xzt3XbhVq1Mj41RgvfRggzUN4Lg` — event_name `workflow_credits`, customer_mapping `by_id` via `stripe_customer_id`

## Hacks SQL ad-hoc à industrialiser

### Hack #1 — Subscription gratuite admin Robert

Pour permettre à Robert d'accéder à son workspace Veridian sans CB, j'ai inséré directement :

```sql
-- Stripe sub créée propre via API (sub_1TbiNIRgvfRggzUNXBKURHw1 trialing 2 ans + coupon ROBERT_ADMIN_FREE_FOREVER)
-- MAIS le webhook Stripe ne tagge pas le workspace → Twenty ne fait pas l'INSERT auto
-- Donc inserts manuels :

INSERT INTO core."billingCustomer" ("workspaceId", "stripeCustomerId")
VALUES ('a8fe3bdf-8aa2-4e65-975b-98f57b61a1ae', 'cus_UauBYImIpDqbcR');

INSERT INTO core."billingSubscription" (
  "workspaceId", "stripeCustomerId", "stripeSubscriptionId",
  status, interval, currency,
  "currentPeriodStart", "currentPeriodEnd", "trialStart", "trialEnd",
  metadata
) VALUES (
  'a8fe3bdf-8aa2-4e65-975b-98f57b61a1ae',
  'cus_UauBYImIpDqbcR',
  'sub_1TbiNIRgvfRggzUNXBKURHw1',
  'trialing', 'month', 'EUR',
  NOW(), NOW() + INTERVAL '2 years',
  NOW(), NOW() + INTERVAL '2 years',
  '{"plan":"PRO"}'
);

INSERT INTO core."billingSubscriptionItem" (
  "billingSubscriptionId", "stripeSubscriptionId", "stripeSubscriptionItemId",
  "stripeProductId", "stripePriceId", quantity, metadata
) VALUES (
  'ef878b0e-934d-4ad5-a7d2-089c95f3db12', -- l'ID de la sub ci-dessus
  'sub_1TbiNIRgvfRggzUNXBKURHw1',
  'si_UauBDxjgTj2ZEI',
  'prod_UZ3ztbggHNj9wq',
  'price_1TZvr9RgvfRggzUNEsd2oIZ5',
  1, '{}'
);
```

**Pourquoi c'est sale** : si Twenty change son schema billing un jour (migration), ces inserts cassent. Et chaque nouveau "free admin" demande 3 inserts SQL manuels.

### Hack #2 — Cause racine du hack #1

Twenty s'attend à initier le checkout LUI-MÊME via sa mutation GraphQL native `checkoutSession` qui :
1. Crée le Stripe Customer avec le bon `metadata.workspaceId` Twenty
2. Pose un Checkout Session avec le price + workspace context
3. Reçoit le webhook `customer.subscription.created` ET sait à quel workspace lier
4. Insère lui-même dans `billingCustomer`/`billingSubscription`/`billingSubscriptionItem`

Quand on crée la sub Stripe FROM OUTSIDE (skill admin manuel), Twenty reçoit le webhook mais ne sait pas dans quel workspace insérer → silent skip.

## Tâches Hub

### T1. Route admin Hub `POST /api/admin/crm/grant-free-access`

```typescript
POST https://app.veridian.site/api/admin/crm/grant-free-access
Authorization: Bearer ${HUB_ADMIN_TOKEN}
Body: {
  workspaceId: string,      // UUID workspace Twenty existant
  email: string,             // email user qui sera le customer Stripe
  plan: 'PRO' | 'ENTERPRISE',
  couponId?: string,         // default 'ROBERT_ADMIN_FREE_FOREVER'
  trialDurationDays?: number // default 730 (2 ans, max Stripe)
}
Response 200: { stripeCustomerId, stripeSubscriptionId, expiresAt }
```

Logique :
1. Vérifie le workspace existe via SQL direct sur Twenty DB (Hub a accès `PG_DATABASE_URL` Twenty)
2. Si déjà une `billingSubscription` active pour ce workspace → return existing (idempotent)
3. Sinon : Stripe API → create Customer + Subscription avec coupon
4. INSERT direct dans Twenty DB (les 3 inserts SQL ci-dessus)
5. Audit log Hub : `action='admin.crm.grant-free-access'`
6. Return l'état

**Note** : c'est un workaround propre tant que Twenty ne propose pas de mutation native pour ce flow. Quand Twenty upstream l'ajoutera (vérifier au prochain rebase), on switchera vers leur mutation.

### T2. Route publique `POST /api/checkout/crm` (mass market self-service)

Le vrai flow paying — déjà spec'd dans `2026-05-27-billing-hub-pour-crm.md`. Reprendre la spec. Différence vs T1 : passe par `Stripe Checkout Session` standard avec CB requise, Stripe propage proprement via webhook (Twenty crée le Customer avec son metadata workspaceId).

Approche recommandée — **utiliser la mutation Twenty native côté Hub** :

```typescript
// Côté Hub, appel GraphQL Twenty pour démarrer le checkout
const checkoutSession = await fetch(`${CRM_METADATA}/`, {
  body: JSON.stringify({
    query: 'mutation { checkoutSessionURL(plan: PRO, requirePaymentMethod: true) { url } }',
    headers: { Authorization: `Bearer ${userTwentyToken}` }
  })
});
// → Twenty crée le Customer côté Stripe avec metadata.workspaceId, retourne URL Checkout
// → User paie, Stripe webhook → Twenty propage automatiquement en DB
```

→ **Plus propre que T1 pour les vrais payants**. T1 est uniquement pour les comptes admin / clients consulting offerts.

### T3. Endpoint Stripe Webhook côté Hub (PAS côté CRM)

Aujourd'hui le webhook Stripe pointe directement sur `crm.app.veridian.site/webhooks/stripe`. Décision team-lead Q6 disait "tout via Hub Stripe" — donc à terme, **le webhook Stripe doit pointer sur Hub** (`app.veridian.site/api/webhooks`), Hub fait la logique, puis Hub propage à Twenty via SQL ou mutation GraphQL.

**Sauf si** on garde Twenty natif autonome pour le billing CRM. Dans ce cas, laisser le webhook direct vers CRM est OK et le Hub écoute juste les subscriptions Hub Veridian (Notifuse/Prospection).

**Décision à arbitrer** : voir la review `2026-05-27-review-offre-crm-veridian.md` Q6.

### T4. Cleanup côté Stripe Dashboard (manuel ou via API)

Stripe LIVE contient des artefacts laissés par l'ancien Twenty (avant le 2026-05-18) :

- Customers Stripe orphelins du tenant Twenty supprimé en 2026-05-18 — à archiver
- Subscriptions actives sur les anciens workspaces purgés — vérifier qu'il n'y a pas de débits récurrents en cours
- Products de l'ancien Twenty avec metadata legacy

Recommandation : audit Stripe via API + rapport "stripe-cleanup-20260527.md", puis archive manuel par Robert (action irréversible donc humain valide).

### T5. Documenter le pattern Twenty Billing Stripe dans CONTRAT-BILLING.md

Le fichier `veridian-platform/CONTRAT-BILLING.md` documente le billing apps commerciales. Ajouter une section "CRM Twenty" qui grave :

- L'archi (Twenty natif `IS_BILLING_ENABLED=true` vs orchestration Hub)
- Les 4 Products Stripe LIVE requis avec metadata
- Le webhook pattern (Stripe → CRM direct, vs via Hub)
- Le flow grant-free-access pour admin/consulting
- Le pattern checkout pour mass market
- Le mapping plans Veridian (Pro/Business) → plans Twenty (PRO/ENTERPRISE)

Référence permanente pour les agents futurs.

## Non-objectifs

- ❌ Patcher le code AGPL Twenty pour ajouter une mutation `grantFreeWorkspaceAccess` (sortirait du périmètre fork léger)
- ❌ Désactiver `IS_BILLING_ENABLED` côté Twenty (déjà actif et fonctionnel)
- ❌ Migrer les Subscriptions Stripe LIVE existantes (Notifuse/Prospection) vers Twenty (chaque app garde son scope)
- ❌ Coder l'UI billing front Twenty (rebrand visuel = vague 3 séparée)

## Tests E2E attendus

```bash
# T1
curl -X POST $HUB/api/admin/crm/grant-free-access \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -d '{"workspaceId":"a8fe3bdf-...","email":"test@veridian.site","plan":"PRO"}'
# → Stripe Sub créée + Twenty DB updated + workspace accessible

# T2
curl -X POST $HUB/api/checkout/crm -d '{"plan":"PRO","email":"client@example.com"}'
# → Retourne URL Stripe Checkout → client paie via CB → workspace provisionné + sub active

# T3 (si pivot webhook → Hub)
# Trigger un product.updated côté Stripe → Hub reçoit → propage à Twenty → vérifier DB
```

## État Stripe à conserver (vault)

Déjà dans `~/credentials/.all-creds.env` :
- `STRIPE_SECRET_KEY` (test) + `STRIPE_SECRET_KEY_LIVE`
- `STRIPE_WEBHOOK_SECRET` (test, Hub) + `STRIPE_WEBHOOK_SECRET_LIVE` (Hub)
- `TWENTY_STRIPE_WEBHOOK_SECRET` (test) + `TWENTY_STRIPE_WEBHOOK_SECRET_LIVE` (ancien legacy, plus utilisé)
- **NOUVEAU** : `BILLING_STRIPE_WEBHOOK_SECRET_CRM_LIVE = whsec_AeMD6tdzIfnkBrDXExVNjx3DSi1TUq2t` (à ajouter au vault)

## Référence implémentation existante

L'agent veridian-crm a écrit la procédure complète + pièges connus dans le skill auto-évolutif :
`~/.claude/skills/admin-twenty/SKILL.md`

Lire ce skill avant d'attaquer ce ticket. Il contient le flow 6-étapes provisioning tenant, le pattern Stripe Products metadata, les pièges Dokploy strip labels TLS, le SmtpDriver qui avale les erreurs, etc.
