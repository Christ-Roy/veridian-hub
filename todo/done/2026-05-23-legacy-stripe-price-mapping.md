# [HUB] Stripe — mapper le Price legacy v2 pour la sub past_due restante

> **Type** : Dette technique catalogue pricing
> **Sévérité** : 🟢 P2 — non-bloquant, mais à régler avant relance commerciale
> **Owner** : agent Hub
> **Créé** : 2026-05-23
> **Réfère** : `lib/pricing/plans.ts` (LEGACY_STRIPE_PRICE_MAPPING),
>   `utils/stripe/prisma-sync.ts:155` (warning émis),
>   `shared/shared/pricing/plans.ts` (catalogue v3)

---

## 0. POURQUOI ce ticket

Détecté pendant la validation Stripe LIVE du **2026-05-22**.

Le compte Stripe LIVE contient encore **1 sub legacy v2 active** :

| Champ | Valeur |
|---|---|
| Subscription ID | `sub_1TUtgWRgvfRggzUNC5OjqiuU` |
| Status | `past_due` |
| Customer | `cus_UTrPVfNjDmFie5` |
| Price ID utilisé | `price_1SvGFYRgvfRggzUNMoGboHCU` (lookup_key `veridian_pro_monthly_v3`, créé 2026-01-30) |
| Product | `prod_Tt20PvX8eWrQPT` |
| Metadata sub | `plan=PRO`, `userUuid=49224170-7da2-411e-8d6b-8a5060e8486b`, `workspaceId=798e2f91-ec10-453e-a8ce-7056be0f3b3c` |

Ce `price_1SvGFY...` n'existe **PAS** dans le catalogue v3 provisionné le
2026-05-22 (`shared/shared/pricing/plans.ts`). Du coup à chaque event
`customer.subscription.updated` sur cette sub, le dispatcher Hub émet :

```
[stripe-sync] Unknown stripe_price_id price_1SvGFYRgvfRggzUNMoGboHCU for
  sub sub_1TUtgWRgvfRggzUNC5OjqiuU — add it to the catalogue or
  LEGACY_STRIPE_PRICE_MAPPING in lib/pricing/plans.ts
```

Résultat actuel : la `metadata.plan = "PRO"` est trouvée en fallback, donc
le dispatcher s'en sort, mais **le warning pollue les logs** et le code
ne traite pas proprement le mapping legacy → catalogue v3.

---

## 1. OPTIONS — choisir

### Option A — Mapper l'ancien Price ID vers une PlanKey v3

Ajouter dans `lib/pricing/plans.ts` (ou équivalent) :

```ts
export const LEGACY_STRIPE_PRICE_MAPPING: Record<string, PlanKey> = {
  // Sub legacy v2 (créée 2026-01-30, pivotée vers v3 le 2026-05-22)
  'price_1SvGFYRgvfRggzUNMoGboHCU': 'VERIDIAN_PRO',  // ou NOTIFUSE_PRO selon mapping business
};
```

**Pro** : pas d'action côté Stripe, le client reste sur sa sub actuelle.
**Con** : on garde une dette permanente dans le code.

### Option B — Migrer la subscription vers un Price v3

Via API Stripe Live :
```bash
# 1. Trouver le bon Price v3 (Veridian Pro mensuel ou Notifuse Pro mensuel
#    selon le mapping business — à confirmer avec Robert)
# 2. Update subscription :
curl -X POST https://api.stripe.com/v1/subscriptions/sub_1TUtgWRgvfRggzUNC5OjqiuU \
  -u "$SK_LIVE:" \
  -d "items[0][id]=si_UTrPPb1ftVbp4m" \
  -d "items[0][price]=price_1TZvr9RgvfRggzUNEsd2oIZ5" \  # exemple Veridian Pro v3 monthly
  -d "proration_behavior=none"
```

**Pro** : code propre, plus de warning.
**Con** : change le contrat avec le client (potentiellement TVA, taxes,
montant). Vu que la sub est `past_due` de toute façon, peut-être l'occasion
de recontacter le client pour qu'il refasse un checkout propre sur le
catalogue v3.

### Option C — Cancel la sub past_due + relancer le client

La sub est `past_due` depuis un moment (cf timestamps `billing_cycle_anchor`).
Probabilité que le client paye encore = à évaluer business. Si non récupérable :
cancel + email de réactivation pour qu'il refasse le checkout propre.

**Pro** : nettoyage complet.
**Con** : risque de perdre le client si on est trop direct.

---

## 2. MA RECO (subordonné senior)

**Option A en attendant + Option C en parallèle** :

1. Ajouter le mapping legacy MAINTENANT pour faire taire le warning et
   stabiliser le dispatcher sur cette sub (5 lignes de code, test unitaire
   sur le mapping). **5 min de boulot.**
2. Robert recontacte le client `cus_UTrPVfNjDmFie5` / `userUuid=49224170...`
   pour discuter de sa sub past_due et lui proposer soit refacturation v3,
   soit cancel propre.

Une fois le client soit recancellé soit re-checkout v3, **archiver ce ticket**
et supprimer l'entrée du LEGACY_STRIPE_PRICE_MAPPING (la dette s'auto-purge).

---

## 3. DEFINITION OF DONE

- [x] Mapping `price_1SvGFYRgvfRggzUNMoGboHCU → veridian-pro` ajouté dans `lib/pricing/plans.ts` (commit `6a85441` puis rebased `00a9fca`/`6a85441` selon historique staging)
- [x] Mapping `price_1SyXiRRgvfRggzUNDEr7BkUj → veridian-pro` (add-on workflow credits metered de la même sub, vérifié via API Stripe LIVE le 2026-05-23)
- [x] Tests unitaires qui vérifient :
  - `getPlanByStripePriceId('price_1SvGFY...')` retourne `veridian-pro` (`__tests__/lib/pricing/helpers.test.ts`)
  - `getPlanByStripePriceId('price_1SyXiR...')` retourne `veridian-pro`
  - Catalogue prime sur legacy (ordre du resolver)
  - Mapping → PlanKey existante (anti-typo)
  - Mapping ne fuit pas dans PLANS / PUBLIC / PAYABLE
  - Dispatcher Hub ne logue plus le warning `Unknown stripe_price_id` (`__tests__/utils/stripe/prisma-sync.test.ts`)
- [x] Section §3.7 ajoutée à `docs/CONTRAT-BILLING.md` (v2.2) — spec garde-fous + runbook audit/nettoyage
- [ ] Re-trigger un event sur la sub via `POST /v1/events/<id>/retry` → logs Hub plus de warning (à faire en prod post-deploy main)
- [ ] **Décision business** sur le sort du client legacy `cus_UTrPVfNjDmFie5` / `userUuid=49224170-7da2-411e-8d6b-8a5060e8486b` (recancel ou re-checkout v3) — **action Robert**
- [ ] Une fois le client résolu : retirer le mapping (la sub legacy n'existe plus). Audit : `curl -G https://api.stripe.com/v1/subscriptions/search -u "$SK_LIVE:" --data-urlencode "query=items.price:'price_1SvGFYRgvfRggzUNMoGboHCU'"` — quand `data: []`, retirer les 2 entrées du mapping + ce ticket → `todo/done/`.
