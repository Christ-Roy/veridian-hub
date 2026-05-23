# [HUB] Refill leads Prospection — câblage bout-en-bout (Stripe LIVE + Hub + dispatch)

> **Type** : Feature billing — flux refill leads complet, du Product Stripe au crédit dans Prospection
> **Sévérité** : 🟡 P1 — débloque le 2e flux de revenu Prospection (welcome leads + achat de leads à la commande)
> **Owner** : sub-agent Opus dédié, worktree isolé
> **Créé** : 2026-05-23 par Robert (arbitrage)
> **Chapeaute** :
>   - `2026-05-22-refill-leads-stripe-checkout-oneshot.md` (P1, checkout one-shot + dispatch)
>   - `2026-05-22-call-credit-leads-welcome-at-provisioning.md` (P1, welcome leads provisioning/upgrade)
> **Réfère** :
>   - `docs/CONTRAT-BILLING.md` §8.4 (refill = flux séparé de `update-plan`, Hub seul maître Stripe)
>   - `docs/PRICING-VERIDIAN.md` §78 (welcome leads) + §95-109 (grille refill dégressive)
>   - `shared/shared/pricing/refill.ts` (calculateur figé, source de vérité)
>   - `shared/shared/pricing/plans.ts` (champ `welcome_leads` par plan)
>   - Endpoint récepteur Prospection : DÉJÀ LIVRÉ (`POST /api/tenants/{id}/credit-leads`)

---

## 0. POURQUOI ce ticket

Le refill leads est **entièrement spécifié** (PRICING-VERIDIAN + CONTRAT-BILLING),
**calculateur de prix figé dans `shared/`**, **endpoint Prospection livré**.

Manquant côté Hub :
1. **Aucun Product/Price refill côté Stripe LIVE** (`curl /v1/prices?type=one_time` retourne 0 prix actif)
2. **Aucune route Hub** pour lancer un Checkout one-shot refill (le seul existant = `/api/billing/checkout` pour les subscriptions)
3. **Webhook ne dispatch pas** `credit-leads` sur `checkout.session.completed` avec `metadata.kind=refill_leads`
4. **Welcome leads jamais crédités** au provisioning ni à l'upgrade Prospection → un nouveau tenant Prospection a **0 lead exploitable**

Conséquence aujourd'hui : un user qui s'inscrit en Prospection Free n'a aucun lead, et même un user payant ne peut pas acheter de leads supplémentaires. Le flux de revenu Prospection est cassé.

Ce ticket est UN SEUL livrable bout-en-bout pour fermer tout d'un coup et tester en vrai.

---

## 1. Périmètre — ce que tu fais / ne fais pas

### Tu fais (côté Hub uniquement)

- Provisionner les Products+Prices refill côté Stripe LIVE + TEST via script idempotent
- Créer la route Checkout one-shot refill côté Hub
- Câbler le webhook → dispatch `credit-leads` HMAC vers Prospection
- Câbler les welcome leads au provisioning + upgrade plan
- Tests Nuclear (toutes les nouvelles routes/lib testées)
- Documenter le flow dans `docs/CONTRAT-BILLING.md` §8.4 (lever le 🔵 "à spec'er")

### Tu ne touches PAS

- **Code Prospection** : endpoint `credit-leads` déjà livré, contrat figé (cf §3 ci-dessous). Si tu trouves un bug côté Prospection, dépose un ticket dans `../veridian-prospection/todo/`.
- **Pricing des subscriptions** : sprint séparé (`pricing-sync-stripe-products`).
- **UI dashboard Prospection** : sera fait par l'agent Prospection dans un ticket séparé.

---

## 2. Architecture cible

```
                      ┌─────────────────────────────────────┐
                      │  USER (workspace Prospection Pro)   │
                      └───────────────┬─────────────────────┘
                                      │ "j'achète 500 leads"
                                      ▼
              ┌───────────────────────────────────────────────┐
              │  POST hub /api/billing/refill-leads/checkout  │
              │  body: { tenantId, quantity }                 │
              │  → calcule prix via shared/pricing/refill.ts  │
              │  → stripe.checkout.sessions.create({          │
              │       mode: 'payment',                        │
              │       customer: <resolveStripeCustomerId>,    │
              │       line_items: [{ price_data: ... }],      │
              │       metadata: {                             │
              │         kind: 'refill_leads',                 │
              │         app: 'prospection',                   │
              │         tenant_id, quantity, plan,            │
              │         idempotency_key (stable)              │
              │       }                                       │
              │     })                                        │
              │  → renvoie url Checkout                       │
              └───────────────────────────────────────────────┘
                                      │
                                      ▼ (paiement Stripe)
              ┌───────────────────────────────────────────────┐
              │  webhook /api/webhooks                        │
              │  event: checkout.session.completed            │
              │  metadata.kind === 'refill_leads'             │
              │  → POST <prospection>/api/tenants/{id}/credit-leads
              │     body: {                                   │
              │       quantity, source: 'purchase',           │
              │       idempotency_key (dérivé event.id),      │
              │       stripe_payment_id,                      │
              │       contract_version: '2.0'                 │
              │     }                                         │
              │     auth: HMAC Hub (Pattern A)                │
              │  → retry exponentiel si fail                  │
              └───────────────────────────────────────────────┘

PARALLÈLEMENT — welcome leads :

              ┌───────────────────────────────────────────────┐
              │  utils/tenants/provision.ts                   │
              │  après création workspace Prospection Free :  │
              │  → POST <prospection>/.../credit-leads        │
              │     body: { quantity: 100, source: 'welcome', │
              │             welcome_plan: 'freemium',         │
              │             idempotency_key: stable           │
              │     }                                         │
              └───────────────────────────────────────────────┘

              ┌───────────────────────────────────────────────┐
              │  utils/stripe/prisma-sync.ts (update-plan)    │
              │  sur upgrade Prospection :                    │
              │  → si welcome_leads(new) > welcome_leads(old) │
              │     POST credit-leads avec DELTA              │
              └───────────────────────────────────────────────┘
```

---

## 3. Contrat figé côté Prospection (DÉJÀ LIVRÉ — NE PAS TOUCHER)

```
POST <prospection>/api/tenants/{tenantId}/credit-leads
Auth: HMAC Hub Pattern A (CONTRAT-HUB.md §6.1)
       header X-Veridian-Signature: sha256=<HMAC(secret_app, body)>
       header X-Veridian-Timestamp: <epoch_seconds>

Body purchase :
  {
    "quantity": <int > 0, ≤ 100000>,
    "source": "purchase",
    "stripe_payment_id": "pi_xxx" | "cs_xxx",
    "idempotency_key": "<uuid v4 stable>",
    "contract_version": "2.0"
  }

Body welcome :
  {
    "quantity": <int > 0>,
    "source": "welcome",
    "welcome_plan": "freemium" | "pro" | "business",   ← REQUIS si source=welcome
    "idempotency_key": "<uuid v4 stable>",
    "contract_version": "2.0"
  }

Réponses :
  200 { credited, balance }                          → crédit appliqué
  200 { credited: 0, balance, idempotent_replay }    → no-op anti-double-grant
  200 { credited, balance, idempotent_replay }       → replay même idem-key
  400 invalid_payload    → contract_version major ≠ 2
  422 invalid_body       → welcome sans welcome_plan, purchase avec welcome_plan, welcome_plan hors enum
  404 tenant_not_found
```

**Mapping plans Hub → Prospection (pour `welcome_plan`)** :
- Hub `free` → Prospection `freemium`
- Hub `pro` → Prospection `pro`
- Hub `business` → Prospection `business`
- Hub `enterprise` → Prospection `business` (pas d'enterprise local côté Prospection)

**Anti-double-grant** : Prospection a un index unique `(workspace_id, welcome_plan)`. Le Hub peut retry sans risque sur welcome.

---

## 4. Livrables détaillés

### Livrable 1 — Provisioning Stripe (script idempotent)

Créer `scripts/setup-stripe-refill.ts` (calqué sur `setup-stripe-prices.ts` existant).

**Sur LIVE et TEST** (boucle sur les 2 clés via `STRIPE_SECRET_KEY_LIVE` puis `STRIPE_SECRET_KEY_TEST`) :
- 1 Product `prospection-refill-leads` (active, name "Refill leads Prospection", metadata `{ kind: "refill_leads", app: "prospection" }`)
- **PAS de Price recurring** : le montant est calculé dynamiquement à chaque checkout via `price_data` (Stripe permet ça en `mode=payment`). Donc le Product seul suffit.

Le script doit :
- Être **idempotent** (re-run = no-op si Product existe déjà avec ce nom + metadata)
- Logger ce qu'il fait
- Sauvegarder le `product_id` dans `~/credentials/.all-creds.env` sous les clés `STRIPE_REFILL_PRODUCT_ID_LIVE` et `STRIPE_REFILL_PRODUCT_ID_TEST` (ou écrire dans un `.env.local.refill.txt` à la racine, Robert fera le merge)
- Tester localement avant push : `pnpm tsx scripts/setup-stripe-refill.ts`

### Livrable 2 — Route Hub `POST /api/billing/refill-leads/checkout`

Créer `app/api/billing/refill-leads/checkout/route.ts`.

Input (Zod-validé) :
```ts
{
  tenantId: string,        // workspace Prospection cible (uuid)
  quantity: number,        // 1..100000
  successUrl?: string,     // défaut = /dashboard/prospection?refill=success
  cancelUrl?: string,      // défaut = /dashboard/prospection?refill=cancel
}
```

Logique :
1. Auth : user connecté ET membre du workspace ciblé (vérifier via Prisma `WorkspaceMember`)
2. Résoudre le **plan local Prospection** du tenant via le contrat existant (lookup table `Tenant` Hub, ou appel `GET <prospection>/api/tenants/{id}` si pas en cache — voir code existant `lib/billing/`). Sans plan = bloquer.
3. Mapper plan Hub → tier refill (`free/freemium` → `freemium`, `pro` → `pro`, `business` → `business`). Enterprise = business pour le refill.
4. Calculer montant via `calculateRefillCostCents(tier, quantity)` depuis `shared/pricing/refill.ts` (déjà importable, alias `@veridian/shared`)
5. Résoudre / créer le Stripe Customer via `resolveStripeCustomerId(userId)` existant
6. Créer Checkout Session :
   ```ts
   stripe.checkout.sessions.create({
     mode: 'payment',
     customer,
     line_items: [{
       quantity: 1,
       price_data: {
         currency: 'eur',
         unit_amount: totalCents,
         product: STRIPE_REFILL_PRODUCT_ID,
         tax_behavior: 'inclusive', // ou ce qui est cohérent avec les subs existantes
       },
     }],
     metadata: {
       kind: 'refill_leads',
       app: 'prospection',
       tenant_id: tenantId,
       quantity: String(quantity),
       refill_tier: tier,
       idempotency_key: stableUuid(tenantId, 'refill', sessionAttempt),
     },
     payment_intent_data: {
       metadata: { /* mêmes clés pour traçabilité */ },
     },
     success_url, cancel_url,
   })
   ```
7. Return `{ url, sessionId }`

Rate-limit : 5 req / min / user (réutiliser le rate-limiter existant `lib/rate-limit/`).

### Livrable 3 — Dispatch webhook → `credit-leads purchase`

Modifier `app/api/webhooks/route.ts` (ou le sous-module qui gère `checkout.session.completed`).

Quand `event.type === 'checkout.session.completed'` ET `session.metadata.kind === 'refill_leads'` :
1. Extraire `tenant_id`, `quantity`, `app` depuis `session.metadata`
2. Si `payment_status !== 'paid'` → log + skip
3. Construire `idempotency_key` **stable** dérivé de `event.id` (pas de random — sinon retry duplique)
4. Appeler `POST <PROSPECTION_PUBLIC_URL>/api/tenants/{tenant_id}/credit-leads` avec HMAC Hub :
   ```json
   {
     "quantity": <number>,
     "source": "purchase",
     "stripe_payment_id": "<session.payment_intent ou session.id>",
     "idempotency_key": "<derived>",
     "contract_version": "2.0"
   }
   ```
5. **Retry exponentiel** sur fail réseau / 5xx (3 tentatives, 1s/3s/10s). Si toujours fail → log `[CRITICAL][refill]` + alerte Telegram (réutiliser `lib/notifications/telegram.ts` si déjà branché, sinon `console.error` structuré qu'un cron pourra rejouer)
6. **JAMAIS** `update-plan` ici — c'est un flux distinct (contrat §8.4)

### Livrable 4 — Welcome leads au provisioning Prospection

Modifier `utils/tenants/provision.ts`.

Après la création réussie du workspace Prospection (appel `provision` Prospection retourne 200) :
- Lire `PLANS[planKey].welcome_leads` depuis `shared/pricing/plans.ts`
- Si > 0 : appeler `credit-leads` avec :
  ```json
  {
    "quantity": <welcome_leads>,
    "source": "welcome",
    "welcome_plan": "<plan local mappé>",
    "idempotency_key": "<uuid v5 deterministe sur tenant_id + welcome_plan>",
    "contract_version": "2.0"
  }
  ```
- **Idempotency_key DÉTERMINISTE** : `uuid.v5(tenant_id + ':welcome:' + welcome_plan, NAMESPACE_REFILL)`. Comme ça, retry = même clé = no-op côté Prospection.
- Log mais ne PAS bloquer le provisioning si fail (l'endpoint est anti-double-grant, un cron de réconciliation pourra réessayer plus tard — laisse un TODO si tu n'as pas le temps de câbler le cron, créé un ticket P2 dans `todo/`).

### Livrable 5 — Welcome leads à l'upgrade plan Prospection

Modifier le handler `update-plan` côté Hub (dans `utils/stripe/prisma-sync.ts` ou la couche dispatcher).

Quand un tenant Prospection upgrade (ex: free → pro, pro → business) :
- Calculer `delta = welcome_leads(new) - welcome_leads(old)`
- Si `delta > 0` : appeler `credit-leads` welcome avec ce delta + `welcome_plan = new plan local`
- Si `delta ≤ 0` (downgrade) : **AUCUN appel** (leads permanents, jamais retirés)
- Idempotency_key stable même règle que livrable 4

### Livrable 6 — Tests Nuclear (obligatoires)

Mode Nuclear actif sur le repo Hub : 0 dette tolérée sur API routes / lib.

À couvrir au minimum :
- `lib/billing/refill-leads.ts` (la lib qui orchestre, à créer) : calcul de prix, mapping plans, idempotency key generation
- Route `/api/billing/refill-leads/checkout` : auth, validation Zod, calcul prix correct, Customer résolu, métadonnées Stripe correctes, rate-limit
- Dispatcher webhook : routage sur `kind=refill_leads`, HMAC bien généré, retry sur 5xx, idempotency stable, pas de fuite vers `update-plan`
- Welcome provisioning : appel au bon moment, quantity correcte, mapping plan correct, idem-key déterministe, fail ne bloque pas provisioning
- Welcome upgrade : delta correctement calculé, downgrade = pas d'appel, idem rejoué = pas de double grant

Tester avec Stripe TEST (pas LIVE) — clé `STRIPE_SECRET_KEY_TEST` dispo.

### Livrable 7 — Documentation

Mettre à jour :
- `docs/CONTRAT-BILLING.md` §8.4 : lever le 🔵 "à spec'er", documenter le flow complet avec headers + body + retry policy
- `docs/PRICING-VERIDIAN.md` §"Implémentations actuelles" : passer welcome leads + refill de ⏳ à ✅
- `~/credentials/.all-creds.env` : ajouter `STRIPE_REFILL_PRODUCT_ID_LIVE` + `STRIPE_REFILL_PRODUCT_ID_TEST` après le run du script (Robert validera)

---

## 5. Definition of Done

- [ ] Script `setup-stripe-refill.ts` créé, run sur TEST + LIVE, Product visible côté Stripe Dashboard
- [ ] `STRIPE_REFILL_PRODUCT_ID_LIVE` + `STRIPE_REFILL_PRODUCT_ID_TEST` documentés (où, comment)
- [ ] Route `/api/billing/refill-leads/checkout` livrée + testée
- [ ] Webhook dispatcher étendu pour `kind=refill_leads` + retry
- [ ] Welcome leads câblé au provisioning (lib/utils tenants)
- [ ] Welcome leads câblé à l'upgrade plan (dispatcher update-plan)
- [ ] Tests Nuclear : 100% des nouvelles routes/lib couvertes
- [ ] Doc `CONTRAT-BILLING.md` §8.4 mise à jour (lever le 🔵)
- [ ] `pnpm build && pnpm test` verts
- [ ] Commit conventionnel(s) avec marker risk approprié (`[risk:medium]` minimum — touche au billing)
- [ ] Push sur `staging`, CI verte
- [ ] Smoke staging : faire un Checkout TEST manuel + vérifier que le webhook créé un `credit-leads` côté Prospection staging
- [ ] Reco de promotion vers main (tier 🟡 = agent arbitre seul, pas demande à Robert) après smoke OK + monitoring 10 min
- [ ] Mettre à jour `todo/` : archiver les 2 tickets chapeautés vers `todo/done/`

---

## 6. Risques + garde-fous

- **Risque idempotency mal géré** → leads crédités 2x ou perdus. Mitigation : tous les idem-keys DÉTERMINISTES (uuid v5 ou hash stable), jamais Math.random.
- **Risque appel `credit-leads` vers le mauvais env** : utiliser `PROSPECTION_PUBLIC_URL` ENV existante (cf code existant `lib/notifuse/` pour le pattern).
- **Risque HMAC secret manquant** : vérifier que `PROSPECTION_HUB_API_SECRET` (ou équivalent dans le contrat Pattern A) existe en prod ET staging. Si pas câblé, créer un ticket P0 séparé et bloquer.
- **Risque Customer Stripe non résolu** : le user peut ne pas avoir de Customer si jamais payé. `resolveStripeCustomerId` doit créer à la volée — vérifier le code existant.
- **Risque tax_behavior incohérent** avec les subs existantes : aligner sur ce qui est utilisé dans `app/api/billing/checkout/route.ts`.

---

## 7. Note importante orchestration

Tu es un sub-agent Opus lancé dans un **worktree isolé** dédié à ce ticket. Tu n'as pas à demander permission de continuer. Tu vas jusqu'au bout (push sur staging + reco de promo) sauf si :
- Tu trouves un bug bloquant côté Prospection (créer ticket dans `../veridian-prospection/todo/`)
- Le HMAC secret prod manque (P0 séparé, bloquer)
- Tu hésites sur un arbitrage business non couvert ici

Sinon, tu exécutes complètement et tu rends un récap final (qu'est-ce qui est sur staging, ce qui reste à promote, état du Dashboard Stripe).
