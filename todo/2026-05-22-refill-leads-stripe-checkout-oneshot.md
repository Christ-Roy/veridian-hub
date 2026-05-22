# [HUB] Refill leads — Stripe Checkout one-shot + dispatch `credit-leads`

> **Type** : Feature billing — flux refill leads (côté Hub)
> **Sévérité** : 🟡 P1 — débloque le 2e flux de revenu Prospection
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Demandeur** : agent Prospection (session sprint UI / pricing)
> **Réfère** :
>   - `docs/CONTRAT-BILLING.md` §8.4 (refill = flux séparé, Hub seul maître Stripe)
>   - `docs/PRICING-VERIDIAN.md` §95-108 (grille dégressive refill)
> **Lié** : tickets Prospection `2026-05-22-refill-1-endpoint-credit-leads.md`
>   et `refill-2-welcome-leads-grant.md`

## Contexte

Le refill leads Prospection (achat de leads à la commande, grille
dégressive 0,50€ → 0,04€/lead) est figé côté business
(`PRICING-VERIDIAN.md`) et côté architecture (`CONTRAT-BILLING.md` §8.4).

§8.4 grave l'invariant : **le Hub reste le seul interlocuteur Stripe**,
y compris pour le Checkout one-shot des leads. Prospection NE crée PAS la
session Checkout, NE reçoit PAS le webhook Stripe. Le Hub propage un
signal de crédit dédié.

Côté Prospection, l'endpoint récepteur est spécifié dans le ticket
`2026-05-22-refill-1-endpoint-credit-leads.md` :
`POST <prospection>/api/tenants/[id]/credit-leads`, auth HMAC Hub, body
`{ quantity, source: "purchase"|"welcome", idempotency_key,
stripe_payment_id?, contract_version }`.

## Demande côté Hub

### Livrable 1 — Stripe Checkout one-shot pour le refill leads

- Créer le flow d'achat : le user Prospection veut acheter N leads → le
  Hub crée une **session Stripe Checkout `mode=payment`** (one-shot, PAS
  une subscription).
- Prix calculé selon la **grille dégressive** `PRICING-VERIDIAN.md` §95-108
  (le prix unitaire dépend du plan + du volume commandé). La grille vit
  dans le `shared/` — source unique.
- `metadata` de la session : `app=prospection`, `kind=refill_leads`,
  `quantity`, le tenant cible — pour le routage au webhook.

### Livrable 2 — Webhook : sur paiement réussi, dispatch `credit-leads`

- À la réception du webhook Stripe `checkout.session.completed` avec
  `metadata.kind=refill_leads` : appeler
  `POST <prospection>/api/tenants/{id}/credit-leads` (HMAC Hub) avec
  `quantity`, `source: "purchase"`, un `idempotency_key` stable (dérivé
  du Stripe event id), `stripe_payment_id`.
- Ne PAS passer par `update-plan` — c'est un flux distinct (contrat §8.4).
- Gérer le retry : si l'appel `credit-leads` échoue, re-tenter (le crédit
  ne doit jamais être perdu après un paiement réussi).

### Livrable 3 — Welcome leads (coordination ticket Prospection 2/3)

Le ticket Prospection `refill-2-welcome-leads-grant.md` recommande que le
**Hub** crédite aussi les welcome leads (leads offerts à la souscription)
via le même endpoint `credit-leads` avec `source: "welcome"`, lors du
provisioning / de l'upgrade de plan. À cadrer avec l'agent Prospection :
- Au provisioning d'un tenant → `credit-leads source=welcome` avec la
  quantité du plan (`PRICING-VERIDIAN.md` §78 : Free 100 / Pro 2000 /
  Business 8000).
- À l'upgrade → créditer le **delta** entre paliers, idempotent (pas de
  double grant si `update-plan` rejoué).

## Trous business couverts

Ce ticket résout les 2 trous relevés dans
`todo/2026-05-21-audit-cross-app-state.md` :
- route `/api/refill-leads` absente
- welcome leads grant non câblé

## Definition of Done

- [ ] `CONTRAT-BILLING.md` §8.4 + `PRICING-VERIDIAN.md` §95-108/§78 lus
- [ ] Checkout one-shot refill leads (mode=payment, prix grille dégressive)
- [ ] Webhook → dispatch `credit-leads` HMAC, idempotent, avec retry
- [ ] Welcome leads câblés au provisioning + upgrade (coord. Prospection)
- [ ] Tests de conformité
- [ ] Coordination : confirmer le schéma du body `credit-leads` avec
      l'agent Prospection (ticket refill 1/3)
