# [HUB] Webhook Stripe central — Hub orchestre les changements de plan vers les apps

> **Type** : Architecture cross-app — Hub source de vérité Stripe
> **Sévérité** : 🔴 P1 — bloque la commercialisation SaaS (pas de paiement
> = pas de revenu)
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Demandeur** : agent Notifuse (décision archi 2026-05-21 validée Robert)
> **Dépendances** :
> - Notifuse `POST /api/tenants/update-plan` déjà câblé (CONTRAT-HUB §5.2)
> - Prospection idem (à vérifier côté agent Prospection)
> - CMS, Analytics : équivalent à venir

---

## Vision business — pourquoi le Hub centralise

Stripe a un concept fort : **Customer = humain qui paie**. Un client
Robert peut payer Notifuse Pro + Prospection Pro + Analytics Free dans
le même Stripe Customer (même CB, même facture, même mois).

Si chaque app reçoit son propre webhook Stripe :
- 3 endpoints à sécuriser (signature Stripe à valider)
- 3 mapping `stripe_customer_id ↔ tenant_id` dupliqués → désync possible
- 3 sources de vérité MRR → dashboard agrégé impossible
- 3 fois la complexité d'un upgrade/downgrade/dunning

Le Hub étant déjà l'orchestrateur du provisioning cross-app (cf.
`CLAUDE.md` racine : "Hub = orchestrateur, les autres apps sont pilotées"),
il est **le bon endroit pour recevoir Stripe**.

---

## Périmètre

### Hub fait
- Recevoir tous les webhooks Stripe
- Valider signature
- Mapper `stripe_customer_id` → `user_id` Hub → tenants par app
- Appeler `POST <app>/api/tenants/update-plan` sur chaque app concernée
- Stocker historique Stripe (audit + dashboard MRR)

### Hub ne fait pas
- ❌ Détecter l'activité (5 mails, 5 leads scrapés) → c'est aux apps
- ❌ Décider du trial intelligent → c'est aux apps (cf. ticket Hub
  `2026-05-21-trial-state-machine.md`)
- ❌ Bandeau UI "trial Pro" → c'est aux apps via leur `/api/limits`

### Apps font
- Endpoint `POST /api/tenants/update-plan` (déjà câblé pour Notifuse,
  Prospection, CMS — à vérifier côté Analytics)
- Émettre `tenant.activity_threshold_reached` quand l'engagement est
  atteint (cf. ticket Notifuse `2026-05-21-trial-eligible-signal.md`)
- Consommer leur propre `/api/limits` pour gater paywall + UI

---

## Livrables

### 1. Endpoint webhook

`POST /api/stripe/webhook` (PUBLIC — pas d'auth JWT, juste signature Stripe)

```typescript
// app/api/stripe/webhook/route.ts (Next.js Hub)
import { stripe } from '@/lib/stripe'

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature')
  const body = await req.text() // raw body pour signature

  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return new Response('Invalid signature', { status: 400 })
  }

  // Persist event dans hub_app.stripe_events (audit + idempotence)
  await persistEvent(event)

  // Dispatch async (return 200 immédiat à Stripe, traitement en background)
  await dispatchEvent(event)

  return new Response('ok', { status: 200 })
}
```

**Idempotence** : Stripe peut retry, donc dédoubler sur `event.id`. La
table `hub_app.stripe_events (id, type, payload, processed_at)` avec
PRIMARY KEY sur `event.id` garantit l'unicité.

### 2. Migration Hub — table stripe_events + lien customer↔tenant

```sql
CREATE TABLE IF NOT EXISTS hub_app.stripe_events (
  event_id     TEXT PRIMARY KEY,           -- evt_xxx de Stripe
  event_type   TEXT NOT NULL,              -- customer.subscription.updated, etc.
  customer_id  TEXT NOT NULL,              -- cus_xxx
  payload      JSONB NOT NULL,             -- événement complet pour audit
  received_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,   -- NULL = en attente
  error        TEXT                         -- NULL si OK, sinon dernier err
);

-- Étendre hub_app.users ou créer hub_app.user_stripe_link
ALTER TABLE hub_app.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

-- Le lien stripe_customer → tenant_id est dérivé de :
--   stripe_customer → hub_app.users.id → hub_app.tenants.user_id
-- Pas besoin de colonne dédiée
```

### 3. Dispatcher — quels événements Stripe on traite

| Event Stripe | Action Hub |
|---|---|
| `customer.subscription.created` | Identifier l'app via `metadata.app` du subscription. Appeler `notifuse/update-plan` avec le nouveau plan + `plan_source=stripe` |
| `customer.subscription.updated` | Idem si le price change (upgrade/downgrade) |
| `customer.subscription.deleted` | Downgrade vers `free` + `plan_source=stripe` |
| `customer.subscription.trial_will_end` | Notification 3j avant fin trial (optionnel pour le V1) |
| `invoice.payment_succeeded` | Audit dashboard MRR |
| `invoice.payment_failed` | Démarrer dunning (suspend après N retries) |
| `customer.deleted` | Soft-delete tous les tenants liés à ce customer |

**Convention `metadata.app`** : chaque Stripe Subscription est créée
avec `metadata = { app: "notifuse" | "prospection" | "analytics" | "cms", tenant_id: "..." }`.
Permet au dispatcher de savoir vers quelle app router sans devoir lookup
en base.

### 4. Idempotence & retry

- Stripe retry les 200 non reçus → on doit return 200 vite (≤30s)
- Le dispatcher async peut foirer (app down) → retry exponential backoff
- Si l'app down > 1h → fallback : créer un ticket interne Telegram
  pour Robert

### 5. Tests

- Webhook signature invalide → 400
- Webhook signature valide + event nouveau → persist + dispatch + 200
- Webhook event déjà processed (rerun) → 200 sans re-dispatch (idempotent)
- `customer.subscription.updated` price change → appel `update-plan` mocké
  vers Notifuse avec le bon plan
- App down (mock 500) → retry + alert si > 3 essais
- E2E avec Stripe CLI : `stripe trigger customer.subscription.created` →
  vérifier que le tenant Notifuse est upgraded

---

## Décisions à figer côté Hub

1. **Stockage Stripe Customer ID** : colonne `users.stripe_customer_id`
   (créé au signup) vs table dédiée. Recommandation : colonne sur
   `users` (1 user = 1 customer).

2. **Métadata Subscription** : convention `{ app: "X", tenant_id: "Y" }`
   ou parse via price_id ? Recommandation : `metadata` car explicite et
   resistant aux migrations Stripe.

3. **Format API call vers les apps** : `POST /api/tenants/update-plan`
   avec body `{ tenant_id, plan, plan_source: "stripe" }` + HMAC.
   Déjà câblé, juste le consommer.

---

## Plan d'attaque

1. Migration Hub : `stripe_events` + colonne `stripe_customer_id`
2. Endpoint `POST /api/stripe/webhook` avec validation signature
3. Dispatcher async (queue Redis + worker ou direct dans le request si simple)
4. Mapping event → app → action (table de routage)
5. Tests unitaires + intégration Stripe CLI
6. Curl live test sur staging avec compte Stripe Test
7. Doc dans `CONTRAT-HUB.md` nouvelle section §X "Webhook Stripe"

---

## Lien avec autres tickets

- Notifuse : `notifuse-veridian/todo/2026-05-21-trial-eligible-signal.md`
  → Notifuse émet "5 mails atteints" vers Hub
- Hub : `veridian-hub/todo/2026-05-21-trial-state-machine.md`
  → Hub consomme le signal Notifuse + state machine trial
- Hub : `veridian-hub/todo/2026-05-20-trial-state-machine.md` ?
  → vérifier si un ticket trial préexistant existe à fusionner

---

## Status

- [ ] Reco terrain : ce qui existe déjà côté Hub (Stripe Customer création
      au signup ? webhook déjà partiellement câblé ?)
- [ ] Migration Hub `stripe_events` + `users.stripe_customer_id`
- [ ] Endpoint webhook + validation signature
- [ ] Dispatcher async
- [ ] Tests unit + intégration Stripe CLI
- [ ] Curl live staging avec Stripe Test
- [ ] Doc CONTRAT-HUB §X
