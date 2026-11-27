# Page pricing Hub — ajouter Veridian CRM

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Bloqué par** : `2026-05-27-review-offre-crm-veridian.md` (Robert valide la grille avec CRM)
> **Compagnon backend** : `2026-05-27-billing-hub-pour-crm.md`

## Objectif

Ajouter Veridian CRM dans la page pricing publique Hub
(`app.veridian.site/pricing` ou route équivalente) + la page dashboard
post-login.

L'user doit pouvoir :
1. Voir le CRM dans la grille tarifaire
2. Comprendre ce que chaque plan inclut côté CRM
3. Cliquer "Démarrer un essai" → flow signup Hub habituel + provisioning
   CRM automatique (call interne route create-tenant)
4. Cliquer "Voir mon CRM" depuis le dashboard si déjà souscrit
5. Acheter pack tokens IA supplémentaires (si décision Q2 = option c)

## État actuel

- Page pricing existe avec Notifuse + Prospection (à confirmer)
- Page dashboard a déjà des cards par app (Notifuse, Prospection, Analytics, CMS)
- Backend create-tenant CRM en cours d'impl (ticket compagnon)

## Tâches

### T1. Mise à jour `PRICING-VERIDIAN.md`

Ajouter une section "Veridian CRM" avec la grille validée Robert.
Format identique à Notifuse/Prospection. Inclut :
- Tableau plans avec colonnes Free / Pro / Business / Enterprise
- Lignes : durée trial, workspaces, seats, custom objects, AI tokens/mois, AI extra packs, white-label, support, etc.
- Section "Achat one-shot tokens IA" si décision Q2 = option c

### T2. Composant React `<CrmPricingCard>`

À ajouter dans `components/pricing/` Hub. Suivre le pattern existant
(`NotifusePricingCard`, `ProspectionPricingCard` s'ils existent).

Props :
- `plan: 'free' | 'pro' | 'business' | 'enterprise'`
- `onCtaClick: () => void`
- `currentPlan?: string` (pour afficher "Plan actuel" badge)

### T3. Page `/pricing` updated

Ajouter CRM dans la grille. 4 colonnes plans, lignes features
condensées. Lien "Voir tout" qui ouvre la page détaillée `/pricing/crm`.

Si décision Q1 = bundle Suite : refondre la page pour montrer la
Suite Veridian comme offre principale, et les apps individuelles
comme alternatives.

### T4. Card dashboard CRM

Ajouter dans `app/dashboard/page.tsx` une `<AppCard>` pour Veridian CRM :
- État `not-provisioned` → CTA "Démarrer un essai gratuit 15 jours"
- État `active` → CTA "Ouvrir mon CRM" (génère magic link via route Hub)
- État `trial-ending-soon` → CTA "Souscrire" + countdown
- État `suspended` → message + CTA "Réactiver"

### T5. Page `/upgrade?plan=<X>&coupon=<Y>`

Already existing pour Notifuse/Prospection. Ajouter le cas `crm` :
- Construit Checkout Stripe Hub avec le plan CRM voulu
- Appli le coupon si fourni (pattern existant)
- Sur succès, webhook Stripe Hub → met à jour `crm_tenants.plan` + reset quota AI

### T6. Page achat extra tokens (si Q2 option c)

`/upgrade/crm/extra-tokens?pack=<5M|20M>` :
- Checkout one-shot non-récurrent
- Sur webhook `checkout.completed` → `crm_tenants.ai_extra_tokens_purchased += pack_size`

### T7. Email transactionnel "Bienvenue CRM"

Notifuse transactionnel envoyé au moment du signup Free CRM :
- Email user avec :
  - Lien magic vers tenant `https://<subdomain>.crm.veridian.site/`
  - Tutorial getting started
  - Mention "Vous avez 15 jours d'essai gratuit, profitez-en"
  - CTA "Voir les plans" → `/pricing/crm`

À câbler via le pattern `tenant.created` cross-app existant (Hub
notifie Notifuse qui envoie).

### T8. Email "Trial CRM ending"

Hooks dans la state machine trial v1.5 :
- J+10 → email "Plus que 5 jours d'essai"
- J+13 → email "Plus que 2 jours, ajoutez votre CB"
- J+15 → email "Trial terminé, choisissez votre plan"

### T9. SEO + landing CRM dédiée (optionnel vague 4)

Page dédiée `https://app.veridian.site/crm` avec :
- Pitch produit CRM méta-modélisé
- Captures Twenty rebrandées
- CTA signup
- Comparaison vs HubSpot / Pipedrive (sans nommer)

## Garde-fous

- ❌ Pas de mention "Twenty" dans l'UI publique (trademark)
- ❌ Pas de logo Twenty dans les pages pricing
- ❌ Mentions copyright AGPL : footer discret "Built with open source ❤️"
  + lien source code obligatoire (obligation AGPL : `https://github.com/Christ-Roy/veridian-crm`)
- ✅ Cohérence visuelle avec le reste du Hub (mêmes couleurs, mêmes
  composants)
- ✅ Mobile-friendly

## Décisions à confirmer

Toutes dans le ticket review compagnon. En particulier :
- [ ] Noms exacts des plans + prix
- [ ] CRM standalone vs bundle Suite Veridian
- [ ] White-label en Business seulement ?
- [ ] On affiche les quotas IA dans la grille publique ou pas ? (Reco : oui, transparence)

## Non-objectifs

- ❌ Rebrand visuel Twenty interne (vague 4 côté CRM)
- ❌ Backend billing (ticket compagnon)
- ❌ Page admin coupons (vague 4+)
- ❌ Comparatif HubSpot (vague 5)
