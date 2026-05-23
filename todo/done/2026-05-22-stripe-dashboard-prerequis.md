# [HUB] Stripe — remise à plat du compte + pré-requis billing

> **Type** : Cleanup compte Stripe + config Dashboard — pré-requis du sprint billing
> **Sévérité** : 🔴 P1 — pré-requis BLOQUANT de `2026-05-21-pricing-sync-stripe-products.md`
> **Owner** : agent Hub (cleanup structurel) + Robert (décisions business)
> **Créé** : 2026-05-22 — réécrit après audit API du compte
> **Réfère** : `todo/2026-05-21-pricing-sync-stripe-products.md` (le gros ticket code),
>   `docs/CONTRAT-BILLING.md` v2.0, `docs/PRICING-VERIDIAN.md` v1.1

---

## 0. POURQUOI ce ticket

Audit API du compte Stripe LIVE le 2026-05-22 : le compte est un **patchwork
de plusieurs époques** (pré-pivot, legacy Twenty, plans métrés abandonnés).
Avant de brancher le billing réel, il faut **remettre le compte à plat** —
sinon le sprint billing construit sur des fondations sales.

Ce ticket = la remise à plat + les pré-requis Dashboard. Le **code** du
branchement (checkout, dispatcher, page pricing) reste dans le gros ticket
`pricing-sync-stripe-products.md`, qui démarre une fois CE ticket vert.

---

## 1. INVENTAIRE RÉEL DU COMPTE (audit API 2026-05-22)

**Compte** : `acct_1SRJNzRgvfRggzUN` — FR, EUR, `business_type: individual`.
✅ `charges_enabled`, `payouts_enabled`, `details_submitted` tous true,
`requirements.currently_due` vide → **le compte peut encaisser et être payé.**
Aucune action d'activation nécessaire (contrairement à ce qu'on craignait).

### 1.1 PRODUCTS — 5 actifs, TOUS à archiver

| Product ID | Nom | Pourquoi obsolète |
|---|---|---|
| `prod_Tm5uvXqi7PvGtg` | Starter | Pricing pré-pivot (plan STARTER n'existe plus) |
| `prod_Tt20PvX8eWrQPT` | Pro | Features mentionnent "Twenty CRM" — Twenty sorti 2026-05-18 |
| `prod_Tt20m7WtsS0z54` | Enterprise | Idem + prix 49€ ≠ grille v1.1 (Business = 89/99€) |
| `prod_TwQZ7SZPthVfBU` | Pro — Workflow Credits | Plan **métré/usage-based** — metered abandonné par v1.1 |
| `prod_TwQZUNX5R3XWOH` | Enterprise — Workflow Credits | Idem métré, hors-sujet |

**Aucun** ne correspond à la grille v1.1 (Free/Pro/Business par app + bundles
Veridian Pro/Business). À archiver tous les 5 (`active: false` — Stripe interdit
le delete d'un product avec historique ; l'archivage est la bonne pratique).

### 1.2 PRICES — 8 actifs, liés aux products obsolètes

8 prices, tous rattachés aux 5 products ci-dessus. S'archivent avec leurs
products (un price devient inutilisable quand son product est archivé ; on les
passe aussi `active: false` explicitement pour propreté).

### 1.3 WEBHOOK ENDPOINTS — 3, dont 2 à traiter

| Endpoint ID | URL | État | Action |
|---|---|---|---|
| `we_1SoQtORgvfRggzUN...` | `app.veridian.site/api/webhooks` | **disabled** | ✅ C'est LE bon endpoint Hub — à **réactiver** + vérifier les events |
| `we_1SyXYARgvfRggzUN...` | `twenty.app.veridian.site/webhooks/stripe` | disabled | ❌ Twenty sorti — à **supprimer** |
| `we_1TSc8LRgvfRggzUN...` | `les-vergers-de-faverolles.fr/api/stripe/webhook` | enabled | ⚠️ **Site CLIENT (verger), PAS Veridian — NE PAS TOUCHER** |

---

## 2. REMISE À PLAT — exécutable par agent (cleanup, pas de vente)

> Périmètre agent : **retirer du legacy**, pas créer de produit commercial.
> Archiver/désactiver/supprimer du mort = sûr et réversible (un product archivé
> se réactive). Le provisioning des nouveaux products = §4, sprint billing.

### 2.1 Archiver les 5 products obsolètes
- [ ] `POST /v1/products/{id}` `active=false` sur les 5 IDs du §1.1
- [ ] Vérifier qu'aucune **subscription active** ne pointe dessus avant
      (`GET /v1/subscriptions?status=active` — si une sub active existe, NE PAS
      archiver son product, remonter à Robert : il y a un client en cours)

### 2.2 Archiver les 8 prices obsolètes
- [ ] `POST /v1/prices/{id}` `active=false` sur les 8 IDs du §1.2

### 2.3 Supprimer le webhook Twenty mort
- [ ] `DELETE /v1/webhook_endpoints/we_1SyXYARgvfRggzUN...`
- [ ] Auditer + retirer `TWENTY_STRIPE_WEBHOOK_SECRET` de `~/credentials/.all-creds.env`
      (grep d'abord qu'aucun code Hub ne le lit)

### 2.4 Réactiver + vérifier le webhook Hub
- [ ] `we_1SoQtORgvfRggzUN...` (`app.veridian.site/api/webhooks`) : le repasser
      `enabled` via `POST /v1/webhook_endpoints/{id}` `disabled=false`
- [ ] Vérifier `enabled_events` : doit couvrir `customer.subscription.created`,
      `.updated`, `.deleted`, `invoice.paid`, `invoice.payment_failed`,
      `checkout.session.completed`. Compléter si manquant.
- [ ] Vérifier que son `secret` (whsec_*) matche `STRIPE_WEBHOOK_SECRET_LIVE`
      dans les creds + l'ENV Dokploy Hub prod. Si mismatch → remonter à Robert
      (rotation de secret = tier 💀, pas en autonomie).

### 2.5 NE PAS TOUCHER
- ❌ Webhook `les-vergers-de-faverolles.fr` — client tiers, hors Veridian.

---

## 3. PRÉ-REQUIS DASHBOARD — décisions + actions Robert

### 3.1 TVA / facturation (décision business)
- [ ] **Stripe Tax** activé ? Vendre du SaaS en UE = TVA obligatoire. Reco : OUI
      (Stripe Tax automatise, ~0,5%/transaction). Sinon TVA manuelle = galère.
- [ ] **Factures automatiques** activées (Settings → Invoicing) — obligation légale.
- [ ] Numérotation séquentielle conforme.

### 3.2 Customer Portal
- [ ] Settings → Billing → Customer Portal : activer (cancel/update CB/factures
      en self-service). Le gros ticket en dépend pour le flow downgrade.

### 3.3 Webhook endpoint staging
- [ ] Créer/vérifier un endpoint TEST → `hub.staging.veridian.site/api/webhooks`
      pour les E2E billing staging (matche `STRIPE_WEBHOOK_SECRET_TEST`).

---

## 4. PROVISIONING DES NOUVEAUX PRODUCTS — sprint billing (PAS ce ticket)

> ⚠️ Créer les products/prices de VENTE = tier 💀 (touche l'argent + impact
> clients). Se fait dans le sprint `pricing-sync-stripe-products.md`, avec go
> explicite de Robert. Ce ticket-ci ne fait que **nettoyer le terrain**.

Cible (cf gros ticket) : 5 products vendables (Notifuse Pro/Business,
Prospection Pro/Business, 2 bundles Veridian) × 2 intervals = ~10 Prices LIVE
+ 10 TEST. Provisionnés par script `scripts/admin/setup-stripe-prices.ts` qui
lit `shared/pricing/plans.ts` et écrit les IDs retournés.

---

## 5. DÉCISIONS ROBERT À FIGER

Du gros ticket : (1) Cal.com vs Calendly, (2) stack support prioritaire,
(3) validation template MJML annuel, (4) Customer Portal → §3.2 ci-dessus.
De ce ticket : (5) Stripe Tax on/off, (6) provisioning scripté vs manuel
(reco : scripté).

---

## 6. ORDRE D'EXÉCUTION

```
CE TICKET
  ├─ §2 remise à plat       → AGENT (cleanup, sûr, réversible)
  └─ §3 config Dashboard    → ROBERT (TVA, Customer Portal)
        ↓ terrain propre + décisions figées
GROS TICKET pricing-sync-stripe-products.md
  └─ §4 provisioning products de vente + code checkout/dispatcher/pricing
```

---

## 7. DoD de CE ticket

- [ ] 5 products obsolètes archivés (après check : 0 subscription active dessus)
- [ ] 8 prices obsolètes archivés
- [ ] Webhook Twenty supprimé + `TWENTY_STRIPE_WEBHOOK_SECRET` retiré des creds
- [ ] Webhook Hub `app.veridian.site/api/webhooks` réactivé + events vérifiés
- [ ] Webhook `les-vergers-de-faverolles.fr` intact (non touché)
- [ ] §3 décisions Robert figées (TVA, Customer Portal, endpoint staging)
- [ ] Feu vert pour `pricing-sync-stripe-products.md`
