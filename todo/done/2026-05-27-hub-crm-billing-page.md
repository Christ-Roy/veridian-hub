# [HUB] Page `/dashboard/billing/crm` — UI premium

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Roadmap UX premium audit `/tmp/audit-crm-needs-2026-05-27.md` §F.1
> - Pattern miroir : `app/dashboard/billing/` (Notifuse/Prospection)
> - Dépend de `todo/2026-05-27-billing-hub-pour-crm.md` (backend doit exister)

## Contexte

Le ticket `pricing-page-update-crm.md` couvre la page **publique**
`/pricing` + la card dashboard root. Mais une fois l'user dans son
dashboard avec un tenant CRM actif, il faut une **page billing dédiée
CRM** au même niveau de polish que les autres apps :

- Plan actuel + bouton upgrade/downgrade
- Quota IA mensuel : progress bar + date reset
- Coût € estimé du mois en cours (transparence)
- Achat one-shot extra tokens (si Q2 = option c gravée)
- Stripe customer portal link (gérer carte, factures, etc.)
- Coupon code field (saisie d'un coupon DEMO_OFFERED)

C'est le **pendant interne** de la page pricing publique : un user qui a
souscrit doit pouvoir gérer son abonnement CRM sans quitter le Hub.

## Action attendue

### 1. Route Next.js

`app/dashboard/billing/crm/page.tsx` (server component) :

```typescript
export default async function CrmBillingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const tenant = await prisma.crmTenant.findFirst({
    where: { userId: userUuid(user) },
    select: {
      id: true,
      plan: true,
      trialEndsAt: true,
      aiTokensQuotaMonthly: true,
      aiTokensUsedThisPeriod: true,
      aiExtraTokensPurchased: true,
      aiCostUsdThisPeriod: true,
      aiTokensPeriodStart: true,
      stripeSubscriptionId: true,
      stripeCustomerId: true,
      status: true,
    },
  });

  if (!tenant) return <NoCrmTenantCTA />;

  return <CrmBillingDashboard tenant={tenant} />;
}
```

### 2. Composants UI

Dans `app/dashboard/billing/crm/components/` :

- `CrmBillingDashboard.tsx` : layout principal (4 sections)
- `CrmPlanCard.tsx` : carte plan actuel + buttons upgrade/downgrade
- `CrmQuotaUsage.tsx` : progress bar tokens + reset countdown
- `CrmExtraTokensPurchase.tsx` : sélecteur pack 5M / 20M tokens + checkout
- `CrmCouponInput.tsx` : input coupon + apply
- `CrmStripePortalLink.tsx` : bouton "Gérer ma facturation" → Stripe Portal

### 3. Mockup textuel des sections

```
┌────────────────────────────────────────────────────────┐
│ Veridian CRM — Mon abonnement                          │
├────────────────────────────────────────────────────────┤
│ Plan actuel : Business                                  │
│ Renouvellement : 15/06/2026 (99€/mois)                  │
│ [ Changer de plan ] [ Annuler l'abonnement ]            │
├────────────────────────────────────────────────────────┤
│ Quota IA mensuel                                        │
│ ▓▓▓▓▓▓▓░░░░ 7.3M / 10M tokens (73%)                    │
│ Coût estimé ce mois : ~$43 USD                          │
│ Reset le 01/07/2026 à 00:00 UTC                         │
│                                                         │
│ Tokens supplémentaires achetés : 0                      │
│ [ Acheter un pack 5M tokens — 30€ ]                     │
│ [ Acheter un pack 20M tokens — 100€ ]                   │
├────────────────────────────────────────────────────────┤
│ Code promo                                              │
│ [______________] [ Appliquer ]                          │
├────────────────────────────────────────────────────────┤
│ [ Gérer ma facturation (Stripe Portal) ]                │
└────────────────────────────────────────────────────────┘
```

### 4. Routes API à utiliser

- `GET /api/crm/billing/me` (à créer) → state complet user-facing
- `POST /api/checkout/crm` (existant via pricing T5) → upgrade plan
- `POST /api/crm/extra-tokens/purchase` (existant via billing T2) → checkout pack
- `POST /api/crm/coupon/apply` (à créer) → vérifie + applique coupon Stripe
- `POST /api/stripe/portal` (existant Hub) → magic link Stripe customer portal

### 5. États visuels

| État tenant | UI affichée |
|---|---|
| `not-provisioned` | CTA "Démarrer mon essai CRM 15j" → POST /api/admin/crm/create-tenant |
| `trial active` (J<10) | Badge "Essai gratuit" + countdown J-XX + CTA upgrade |
| `trial ending` (J 10-15) | Banner orange "Plus que X jours" + CTA upgrade prominent |
| `pro/business/enterprise active` | Vue normale (cf mockup) |
| `past_due` | Banner rouge "Paiement échoué" + CTA mettre à jour CB Stripe Portal |
| `suspended` | Vue lecture seule + CTA "Réactiver mon abonnement" |

### 6. Quota visuel — règle PRICING-VERIDIAN

⚠️ Vérifier la **philosophie figée Robert** : "tout illimité partout,
l'app ne doit JAMAIS être défigurée par des limites visibles".

→ Conséquence : la progress bar quota IA est **uniquement dans la page
billing Hub** (page admin gestion), **JAMAIS dans Twenty CRM lui-même**.
Twenty reste "tout illimité" du point de vue UX. L'user voit le quota
seulement quand il vient gérer son billing — c'est de la transparence
admin, pas un mur béton produit.

### 7. Accessibilité + responsive

- Mobile-friendly (testé < 480px)
- Contraste WCAG AA sur la progress bar (couleurs à 3 paliers : vert < 70%, orange 70-90%, rouge > 90%)
- Labels ARIA pour les boutons d'action
- Keyboard navigation totale

## Tests / DoD

- [ ] Test route `/dashboard/billing/crm` :
  - User sans tenant CRM → CTA démarrer essai
  - User trial actif → progress bar + countdown
  - User business → full dashboard
  - User suspended → vue lecture seule
- [ ] Test composants :
  - `CrmQuotaUsage` snapshot à 50% / 80% / 95%
  - `CrmCouponInput` accepte / rejette codes
- [ ] Test E2E Playwright :
  - Login → /dashboard/billing/crm → click upgrade → redirect Stripe checkout
  - Login → /dashboard/billing/crm → buy extra tokens → confirm Stripe modal
- [ ] Test responsive mobile 360px / desktop 1920px
- [ ] No leak ENV (pas de stripeSecretKey côté client)
- [ ] Audit log écrit pour chaque action (upgrade, purchase, coupon apply)

## Non-objectifs

- ❌ Backend billing (déjà couvert par `billing-hub-pour-crm.md`)
- ❌ Page pricing publique (couvert par `pricing-page-update-crm.md`)
- ❌ UI admin coupons (vague 5+)
- ❌ Graph historique consommation IA sur 6 mois (vague 5+)
- ❌ Re-render Twenty CRM avec quota visible (interdit par philo PRICING)
