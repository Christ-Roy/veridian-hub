# Hub CRM — Stripe Products + dispatcher mapping (BLOQUÉ Q1-Q7)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub (à reclaim quand Robert tranche)
> **Créé** : 2026-05-27
> **Bloqué par** : `2026-05-27-review-offre-crm-veridian.md` (Q1-Q7 Robert non gravées)

## TL;DR

Sprint hub-crm-v1-staging Task #2 livrée en mode dégradé conforme au
FREEZE 2026-05-27 14:13. Seule la **structure** (`AppKey` étend
`'crm'`) a été propagée. Tout le reste — provisioning Stripe Products
CRM TEST + extension `lib/stripe/dispatcher.ts` — reste à faire dès
que Robert grave les 7 décisions du ticket review.

## Ce qui est livré (acquis, à NE PAS refaire)

- ✅ `veridian-infra@main` commit `b29d981` — `AppKey` étend `'crm'`
  dans `shared/pricing/types.ts` (1 ligne, structure seule). 33/33
  tests shared verts.
- ✅ `veridian-hub@staging` commit `0f73ca6` — bump submodule pointer
  `8dc127a → b29d981`. Pre-push hook tout vert. Tsc sans nouvelle
  erreur.

## Ce qui reste à faire (UNBLOCK Q1-Q7)

### 1. Catalogue plans canonique (`shared/shared/pricing/plans.ts`)

Selon décisions Q1 (position grille) + Q2 (quota IA) + Q5 (white-label)
+ Q6 (IS_BILLING_ENABLED Twenty) :

- Si Q1 = Option B (CRM inclus Pro lecture seule / Business complet) :
  - Ajouter champ `featureCrm: 'none' | 'readonly' | 'full'` sur Plan
    (mise à jour `types.ts`)
  - Ajouter `aiTokensMonthlyQuota: number` selon barème Q2
  - Ajouter `featureCrmWhiteLabel: boolean` selon Q5
  - Mettre à jour Pro / Business / Veridian-Pro / Veridian-Business
  - **PAS** créer de plan standalone `crm-*` (option B = pas de SKU
    standalone)
- Si Q1 = Option A (CRM standalone) :
  - Créer plans `crm-free`, `crm-pro`, `crm-business` complets
- Si Q1 = Option C (bundle Suite) :
  - Refondre les bundles veridian-pro / veridian-business
- Si Q2 = option (c) hard cap + pack one-shot :
  - Ajouter plan one-shot `crm-tokens-pack` (price_eur 30, oneshot)
  - Ajouter champ `aiTokensOneshot: number`
- Push commit submodule + bump pointer Hub

### 2. Provisioning Stripe TEST (preprod)

- Clé `STRIPE_SECRET_KEY_PREPROD` dans `~/credentials/.all-creds.env`
- Compte preprod `acct_1SqkTMDohhveg6Mt`
- Pattern : copier `scripts/admin/setup-stripe-prices.ts` →
  créer `setup-stripe-crm-prices.ts` idempotent (ou étendre l'existant
  si la modif catalogue suffit)
- Si Q1 Option B + Q2 option (c) : seul **1 Product one-shot**
  `Veridian CRM AI Tokens Pack` (mode payment, Price 3000) suffit —
  les Products Pro/Business existent déjà
- Stocker IDs retournés dans `shared/pricing/plans.ts` champs
  `stripePriceIdLive` / `stripePriceIdTest`

### 3. Étendre `lib/stripe/dispatcher.ts`

Handlers à ajouter dans `dispatchStripeEvent()` :

- **`checkout.session.completed`** + `mode === 'payment'` +
  `metadata.kind === 'crm_tokens_pack'` → CREDIT tokens count sur
  CrmTenant (incrémenter `tokens_balance`, nouveau champ migration
  Agent A à coordonner)
- **`customer.subscription.updated`** + plan upgrade vers `business` →
  SET `featureCrm = 'full'` côté CrmTenant (via `lib/crm/client.ts`
  d'Agent A) si user a un CrmTenant
- Audit log + alert Telegram en cas d'échec après 3 retries
- Pattern à reproduire : `handleRefillLeadsCheckout` (refill leads
  one-shot, déjà éprouvé v1.4)

### 4. Tests Vitest (Mode Nuclear obligatoire — tier 🔴 billing)

- `__tests__/lib/stripe/dispatcher.test.ts` — étendre avec :
  - happy path crm_tokens_pack credit
  - subscription business → featureCrm full
  - failure modes (CrmTenant absent, balance UPDATE échoue, etc.)
- `__tests__/scripts/admin/setup-stripe-crm-prices.test.ts` —
  Stripe API mockée, vérifie idempotence

### 5. Coordination Agent A (CrmTenant table)

Agent A crée la migration `crm_tenants` (Task #1). Pour le dispatcher
crm_tokens_pack, il faut un champ `tokens_balance INT DEFAULT 0`.
Soit Agent A l'ajoute dans sa migration initiale, soit une migration
follow-up (séquentielle, jamais en parallèle de la première).

## Garde-fous

- ❌ NE PAS appeler Stripe API tant que Q1-Q7 pas gravés (risque de
  créer des Products/Prices qu'on devra archiver)
- ❌ NE PAS modifier le dispatcher avec un mapping crm conjectural
  (code prod billing = tier 🔴, pas de [risk:low])
- ❌ NE PAS toucher au pricing Live tant que TEST pas validé
- ✅ Marker `[risk:low]` autorisé pour la modif catalogue plans pure
  (data) MAIS pas pour dispatcher/Stripe API

## Reprise

Quand Robert grave les Q1-Q7 dans
`todo/2026-05-27-review-offre-crm-veridian.md` section "Décisions
Robert" :

1. Re-claim Task #2 du sprint hub-crm-v1-staging (ou créer Task
   équivalente dans le sprint suivant)
2. Suivre étapes 1→5 ci-dessus dans l'ordre
3. Push staging, attendre vert
4. Tier 🔴 → recommandation écrite + promo main par l'agent (protocole
   §20 CI-ARCHITECTURE)

## Références

- Sprint Task : #2 hub-crm-v1-staging (closed pending FREEZE 2026-05-27)
- Ticket review business : `todo/2026-05-27-review-offre-crm-veridian.md`
- Ticket impl backend : `todo/2026-05-27-billing-hub-pour-crm.md`
- PRICING-VERIDIAN.md v1.1 (à updater post-Q1-Q7)
- CONTRAT-BILLING.md §3 (mapping Stripe Price → Plan)
- Memory : `reference_stripe_provisioning_2026-05-22.md`
- Memory : `feedback_nuclear_mode_tests.md` (tier 🔴 dispatcher)
