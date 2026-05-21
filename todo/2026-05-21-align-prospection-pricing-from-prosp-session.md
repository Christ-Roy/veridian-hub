# Alignement pricing Prospection + bundles cross-app (session agent Prosp 2026-05-21)

> **Type** : Mise à jour pricing catalogue Hub + page /pricing
> **Sévérité** : 🔴 P1 — pricing en prod actuellement incohérent avec décisions business arrêtées
> **Owner** : agent Hub
> **Demandeur** : agent Prospection (session Robert 2026-05-21 nuit)
> **Source de vérité décisions** : `veridian-prospection/todo/2026-05-21-business-plan-pricing-features.md`
> **Plan-as-code Prospection** : `veridian-prospection/src/lib/billing/plans.ts`
> **Effort estimé** : 1-2h (modif catalogue + tests page pricing + smoke staging)

---

## Contexte

Session pricing Prospection 2026-05-21 (Robert + agent Prosp) a arrêté :
- Pricing standalone Prospection : Pro **29€/mois**, Business **89€/mois** (au lieu de Hub catalogue actuel Pro 29€ ✓ / Enterprise 49€ ✗)
- Mécanique leads : **welcome pack one-shot + refill à la commande Stripe Checkout** (au lieu de quota cumulatif Hub actuel)
- Bundles cross-app revus : **Veridian Pro 49€** (-15% vs 58€), **Veridian Business 149€** (-20% vs 188€)
- Notifuse aussi à mettre à jour : **Pro 29€** (au lieu de Hub catalogue actuel 19€), **Business 99€** (au lieu de 49€)

Le pricing actuel `veridian-hub/lib/pricing/plans.ts` est en prod sur `app.veridian.site/pricing`. À aligner.

---

## Livrables

### 1. Mise à jour `lib/pricing/plans.ts`

#### Prospection — renommer + repricer

**Renommer `prospection-enterprise` → `prospection-business`** (PlanKey + objet PLANS). Cohérence cross-app : Notifuse dit `business`, on garde la même terminologie pour les apps SaaS de catégorie B (cf VISION-BUSINESS.md §"Structure des plans").

**Mettre à jour `prospection-free`** :
- `quotas.prospection.leads_total`: 300 → **100** (welcome pack permanent)
- Tagline + features : reformuler en "100 prospects offerts pour démarrer" (pas "300 prospects visibles")

**Mettre à jour `prospection-pro`** :
- `price_eur`: 29 ✓ (déjà bon)
- `price_eur_yearly_per_month`: 24 ✓ (déjà bon)
- `quotas.prospection.leads_total`: 100_000 → **2_000** (welcome pack)
- Tagline : "Pour les commerciaux indépendants" ✓ (garder)
- Features : remplacer "100 000 prospects" par "2 000 prospects offerts + achat à la demande dégressif"

**Renommer + repricer `prospection-enterprise` → `prospection-business`** :
- Nouveau `PlanKey`: `'prospection-business'`
- `name`: 'Prospection Business' (au lieu de 'Prospection Enterprise')
- `price_eur`: 49 → **89**
- `price_eur_yearly_per_month`: 41 → **74** (89 × 0.83 arrondi)
- `quotas.prospection.leads_total`: 500_000 → **8_000** (welcome pack)
- Tagline : "Pour les équipes de vente structurées" ✓ (garder)
- Features : remplacer "500 000 prospects" par "8 000 prospects offerts + achat à la demande -65% vs Free"

#### Notifuse — aligner avec décision cross-app

**Mettre à jour `notifuse-pro`** :
- `price_eur`: 19 → **29**
- `price_eur_yearly_per_month`: 16 → **24** (29 × 0.83)

**Mettre à jour `notifuse-business`** :
- `price_eur`: 49 → **99**
- `price_eur_yearly_per_month`: 41 → **82** (99 × 0.83)

**Note** : ces prix Notifuse sont déjà ceux de la VISION-BUSINESS.md `Grille Notifuse` (29€/99€), donc juste mise en cohérence du catalogue Hub avec la VISION.

#### Bundles — repricer avec dégression -15% / -20%

**`veridian-pro`** (Notifuse Pro 29 + Prospection Pro 29 = 58 à la carte) :
- `price_eur`: 39 → **49** (-15% vs 58)
- `price_eur_yearly_per_month`: 33 → **41** (49 × 0.83)
- Features : recalibrer "Économie de 9€/mois vs à la carte" ✓ (montant inchangé)
- Garder `recommended: true` (hero CTA)

**`veridian-business`** (Notifuse Business 99 + Prospection Business 89 = 188 à la carte) :
- `price_eur`: 79 → **149** (-20% vs 188)
- `price_eur_yearly_per_month`: 66 → **124** (149 × 0.83)
- Features : recalibrer "Économie de 39€/mois vs à la carte"
- Mettre à jour aussi `quotas.notifuse.emails_per_month` si on revoit le contenu (à confirmer agent Hub : on garde 500k emails ?)
- `quotas.prospection.leads_total`: 500_000 → **8_000** (welcome pack inclus)

### 2. Mise à jour `lifetime-site-vitrine` + `lifetime-partner`

Ces plans offerts donnent "équivalent Pro" / "équivalent Business". À mettre à jour cohérence quotas :
- `lifetime-site-vitrine`: équivalent Veridian Pro → 2 000 leads Prosp (welcome) + 50k emails Notifuse, 5 seats
- `lifetime-partner`: équivalent Veridian Business → 8 000 leads Prosp + 500k emails Notifuse, 25 seats

### 3. Tests

#### Mise à jour tests existants

- `__tests__/components/pricing/PricingGrid.test.tsx` : assert nouveaux prix affichés (49€, 149€, etc.)
- `__tests__/lib/pricing/*.test.ts` : si helpers font des assertions sur prix exacts

#### Nouveau test régression cross-app

Ajouter un test qui vérifie la cohérence des prix bundles vs prix à la carte :

```ts
test("bundle veridian-pro = sum standalone * (1 - 0.15)", () => {
  const standaloneSum = PLANS['notifuse-pro'].price_eur + PLANS['prospection-pro'].price_eur;
  const bundle = PLANS['veridian-pro'].price_eur;
  expect(bundle).toBeCloseTo(standaloneSum * 0.85, 0);
});

test("bundle veridian-business = sum standalone * (1 - 0.20)", () => {
  const standaloneSum = PLANS['notifuse-business'].price_eur + PLANS['prospection-business'].price_eur;
  const bundle = PLANS['veridian-business'].price_eur;
  expect(bundle).toBeCloseTo(standaloneSum * 0.80, 0);
});
```

Garde-fou : si quelqu'un change un prix standalone sans recalibrer le bundle, la CI explose.

### 4. Mise à jour Stripe Products (à faire après déploiement code)

Les `stripePriceId` sont actuellement `null` (à câbler). Quand Robert créera les vrais Stripe Products :
1. Créer les Price IDs pour les nouveaux prix dans Stripe Dashboard (ou via `scripts/admin/setup-stripe-prices.ts`)
2. Mettre à jour `stripePriceId.month` et `stripePriceId.year` dans `plans.ts`
3. Documenter dans `docs/STRIPE-PRODUCTS-SETUP.md` (à créer)

### 5. Vérification page `/pricing` live

Après deploy staging :
1. Visiter `https://hub.staging.veridian.site/pricing`
2. Vérifier que les nouveaux prix s'affichent correctement
3. Vérifier que les économies bundles sont bien calculées (108€/an et 468€/an mentionnés)
4. Vérifier JSON-LD SEO (prix dans `AggregateOffer`)

Puis prod après validation Robert.

---

## Hors scope (autres tickets)

- **Implémentation côté Prospection** : mécanique welcome pack + Stripe Checkout one-shot par commande de leads. Couvert par ticket Prosp séparé (à créer post-pricing-arrêté).
- **Implémentation côté Notifuse** : prix V37 déjà arrêtés à 29€/99€ dans la VISION-BUSINESS, juste mise en cohérence Hub ici.
- **Stripe Products création** : ticket dédié quand Robert prêt à câbler le checkout vrai.
- **Plan Enterprise sur devis** (50k+ leads/mois, SSO/SAML/SLA) : à discuter dans une session ultérieure, pas dans ce ticket.

---

## Definition of Done

- [ ] `lib/pricing/plans.ts` mis à jour avec tous les nouveaux prix + renommage `enterprise`→`business`
- [ ] Tests régression bundles passent
- [ ] Tests `PricingGrid` mis à jour
- [ ] Smoke staging `https://hub.staging.veridian.site/pricing` visuellement OK
- [ ] Smoke prod après promote
- [ ] Notif Robert quand prod live (sanity check humain final)
- [ ] Ce ticket archivé dans `todo/done/`

## Coordination

L'agent Prosp côté `veridian-prospection/src/lib/billing/plans.ts` a déjà arrêté ses prix (29€/89€ pour Pro/Business). C'est la source de vérité côté app. Le Hub doit s'aligner dessus (catalogue marketing) et pas l'inverse.

Si l'agent Hub identifie une incohérence ou un blocage technique (genre Stripe ne permet pas un changement de prix sur subscription active sans migration plan), répondre dans ce ticket avec `## Réponse — YYYY-MM-DD` et notifier Robert pour arbitrage.
