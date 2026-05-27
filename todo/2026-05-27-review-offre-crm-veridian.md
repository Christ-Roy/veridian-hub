# Review offre Veridian — intégrer le CRM dans la grille

> **Sévérité** : 🔴 P0 (bloque les 2 tickets impl ci-dessous)
> **Owner** : Robert + agent veridian-hub (assist)
> **Créé** : 2026-05-27
> **Type** : ticket de décision business (PAS d'impl)
> **Compagnons à débloquer après cette review** :
> - `2026-05-27-billing-hub-pour-crm.md` (P0 impl backend)
> - `2026-05-27-pricing-page-update-crm.md` (P0 impl UI publique)

## Pourquoi ce ticket

Veridian CRM (fork Twenty rebrandé) arrive dans la stack 2026-05-27.
Décision Robert 2026-05-27 : **mode SaaS complet** côté CRM, billing
orchestré par le Hub (pas de Stripe Twenty natif activé).

Avant de coder, on doit graver :
1. La place du CRM dans la grille tarifaire Veridian
2. Le quota IA par plan (sinon le CRM peut coûter cher en Anthropic)
3. La stratégie coupon Stripe pour démos clients consulting
4. L'articulation Free → Pro → Business → Enterprise côté CRM
5. Le positionnement vs Prospection (qui converge plus tard)

## Contexte technique court (rappel)

- ✅ Twenty fork déployé `https://crm.staging.veridian.site` (vague 2)
- ✅ Patch `MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY = Number.MAX_SAFE_INTEGER` (AGPL)
- ✅ Création tenant via API GraphQL Twenty native validée bout-en-bout
- ✅ Bearer API key 1 an + push leads via REST validé
- ⚠️ **77% du module billing Twenty est `@license Enterprise`** → on NE PEUT PAS modifier ce module ni utiliser sa logique de plans/credits
- ⚠️ `IS_BILLING_ENABLED=false` côté Twenty CRM (= tout illimité tant qu'on n'a pas notre propre logique de quota)
- ⚠️ Anthropic/OpenAI API key = clé Veridian **server-wide** (pas par workspace nativement). Donc **TON portefeuille paie l'IA de tous les tenants** tant qu'aucun cap n'est posé

## Questions à trancher avec Robert (cette review)

### Q1 — Position du CRM dans la grille Veridian

**Option A — CRM = produit standalone payant**
- Plan Free 15j visible (cohérent Notifuse) → Pro 39€ → Business 149€ → Enterprise sur devis
- Vendu indépendamment de Notifuse/Prospection

**Option B — CRM = inclus dans Business+ Veridian**
- Plan Free Veridian = pas de CRM, juste Notifuse/Prospection trial
- Plan Pro Veridian (29€) = CRM en lecture seule (1 workspace, lecture import)
- Plan Business Veridian (99€) = CRM complet + Notifuse + Prospection
- Plan Enterprise = idem + white-label + custom domains

**Option C — Bundle "Veridian Suite" avec CRM dedans**
- Veridian Suite Pro 49€/mo = CRM + Notifuse + Prospection light
- Veridian Suite Business 199€/mo = tout illimité

**Reco à 60%** : Option B parce qu'elle reste cohérente avec la grille existante (les chiffres 29€/99€ sont déjà gravés dans PRICING-VERIDIAN.md) sans inventer un 3e produit standalone. Le CRM devient un **différenciant Business** qui justifie le saut 29→99€.

### Q2 — Quota IA par plan

Twenty intègre des features IA partout (génération de texte sur fiches, chat agent, workflows AI, classification). C'est ton coût Anthropic/OpenAI direct via la clé serveur.

**Estimation coûts Anthropic Claude Sonnet pour un user actif** :
- Free 15j actif → ~50k tokens consommés (~0.30€)
- Pro user mois moyen → ~500k tokens (~3€)
- Pro user power → ~3M tokens (~18€)
- Business agence (5 users actifs) → ~20M tokens (~120€)

**Proposition quotas** :

| Plan | Quota IA mensuel | Coût Anthropic max | Marge plan |
|---|---|---|---|
| Free Veridian | 100k tokens (15j) | 0.50€ one-shot | NA (acquisition) |
| Pro 29€ | 1.5M tokens/mo | 9€/mo | 20€ net |
| Business 99€ | 10M tokens/mo | 60€/mo | 39€ net |
| Enterprise | illimité (négocié contrat) | NA | dépend |

**Au-delà du quota** :
- (a) **Hard cap** : message "Quota IA mois atteint, upgrade" — pas de surprise facture (reco Robert philo "pas de mur béton" → mais ici c'est un mur soft, pas un mur sur la feature CRM elle-même)
- (b) **Soft cap + pay-as-you-go** : on facture 0.0002€/1k tokens supplémentaires côté Stripe Hub (metered usage)
- (c) **Hard cap mais possibilité d'acheter pack one-shot** (ex. +5M tokens = 30€) via Stripe Checkout côté Hub

**Reco à 75%** : Option (c) — cohérent avec le pattern Prospection (achat de leads one-shot). Génère une 2e occasion de paiement et reste prévisible pour l'user.

### Q3 — Coupons Stripe pour démos clients consulting

Robert veut **offrir des accès gratuits étendus** à des clients proches pour qu'il leur fasse une démo "tenant sur mesure avec leur data".

**Pattern existant Veridian** : Stripe propose nativement des coupons (`%off`, `amount_off`, `duration: forever/repeating/once`). Les autres apps Veridian (Notifuse/Prospection) ne les utilisent pas encore systématiquement.

**Proposition** :
- **Coupon "DEMO_CONSULTING_3M"** : 100% off pendant 3 mois (`duration: repeating, duration_in_months: 3`) sur plan Business CRM
- **Coupon "DEMO_LIFETIME"** : 100% off forever pour les amis/early adopters
- **Coupon "ROBERT_OFFERT"** : 100% off forever — code qu'on génère à la volée pour 1 client précis (via API Stripe côté admin Hub)

**Q3.1** : on veut une UI admin Hub pour générer les coupons à la demande, ou Robert les crée à la main dans dashboard Stripe ? **Reco** : à la main au début (déjà existant côté Stripe), UI admin Hub si plus de 20/mois.

**Q3.2** : les coupons s'appliquent au moment du checkout. Donc le client passe par checkout Hub (carte requise pour activer le coupon, ou pas selon `payment_method_collection`). **Reco** : `payment_method_collection: 'if_required'` → si coupon 100% off, pas de CB demandée (sinon ce n'est plus une démo "offerte").

### Q4 — CRM + Prospection : convergence ou parallèle ?

Long terme, Prospection a vocation à migrer vers le CRM méta-modélisé (cf `docs/spec/00-VISION.md`). Court terme :

- Le CRM = customisable méta-modélisé (Twenty), positionné "Business+"
- Prospection = cold outbound qualifié, positionné "Pro+"
- Un user Pro Veridian (29€) → Prospection seul
- Un user Business Veridian (99€) → Prospection + CRM

**Question** : on autorise l'import auto Prospection → CRM dès le plan Business (= un bouton "envoyer ces 50 leads au CRM" dans Prospection) ? **Reco** : OUI, c'est un gros différenciant Business qui justifie le saut de 29 à 99€.

### Q5 — White-label CRM en Business ?

Le rebrand visuel Twenty (logo, nom "Twenty" → "Veridian CRM") est en
vague 3. Au-delà :

**Option** : un client Business+ peut afficher son propre logo dans
son tenant CRM (au lieu de "Veridian CRM"). C'est natif Twenty (champ
`Workspace.logo`) mais nécessite d'exposer le setting UI.

**Reco** : YES en Business+ — pas en Pro. Cohérent avec Notifuse
white-label Business.

### Q6 — Plans Twenty natifs (PRO / ENTERPRISE) — qu'en fait-on ?

Twenty natif expose un enum `BillingPlanKey: PRO | ENTERPRISE` dans le
code. Si on garde `IS_BILLING_ENABLED=false`, ces plans ne sont jamais
matérialisés côté Twenty (pas de subscription Stripe Twenty, pas de
gate basé sur le plan).

**Question** : on fait correspondre nos plans Veridian → plans Twenty
natifs pour les features que Twenty gate par plan ? (Ex : `workspace.smartModel` premium uniquement pour Veridian Business+ = on simule Twenty `PRO` plan via une migration AGPL custom Veridian).

**Reco** : **NON pour la vague 3-4**. On laisse `IS_BILLING_ENABLED=false`,
toutes les features Twenty AGPL sont accessibles à tous (illimité). Le
gating Veridian se fait **uniquement au niveau du Hub** (quota tokens
IA). Ça nous laisse libre et ça évite de toucher au billing Twenty.

Plus tard (vague 5+), si on veut gater des features Twenty spécifiques
par plan Veridian (ex. workflow AI uniquement Business), on regardera
le module workflows Twenty et on verra ce qui est AGPL/EE.

### Q7 — Timing rollout

**Proposition** :
1. **Vague 3 maintenant** : impl ticket Hub billing CRM + page pricing
   updated (sans rollout public, déployé en staging)
2. **Vague 4 (semaine d'après)** : rebrand visuel CRM + premier client
   consulting (Robert te file un email, je crée le tenant avec coupon
   `ROBERT_OFFERT` → 100% off forever)
3. **Vague 5 (mois suivant)** : ouverture publique + page pricing
   updated en prod
4. **Vague 6** : white-label Business + import Prospection→CRM

## Livrables de ce ticket

C'est un ticket de **décision**, pas d'impl. Robert répond aux 7
questions ci-dessus (en éditant ce fichier section "Décisions Robert"
ci-dessous, ou par discussion avec l'agent qui retranscrit).

Une fois les réponses gravées, l'agent veridian-hub peut attaquer les 2
tickets compagnons sans hésitation.

## Décisions Robert

> À remplir par Robert. Format : Q1 → décision finale + raison courte.

| # | Décision | Raison / contexte |
|---|---|---|
| Q1 | _à trancher_ | |
| Q2 | _à trancher_ | |
| Q3 | _à trancher_ | |
| Q4 | _à trancher_ | |
| Q5 | _à trancher_ | |
| Q6 | _à trancher_ | |
| Q7 | _à trancher_ | |

## Non-objectifs

- ❌ Coder quoi que ce soit avant que ce ticket soit fermé
- ❌ Modifier `PRICING-VERIDIAN.md` avant validation Robert
- ❌ Activer `IS_BILLING_ENABLED=true` côté Twenty (le module EE reste off)
- ❌ Re-débattre la philo "tout illimité" — elle reste, le quota IA est un cas spécial coût-direct
