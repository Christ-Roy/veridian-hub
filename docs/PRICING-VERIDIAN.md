# PRICING-VERIDIAN.md — Source de vérité pricing & trial cross-app

> **Statut** : v1.0 (2026-05-21) — figé par Robert
> **Scope** : pricing + flow trial + responsabilités cross-app pour TOUTES
> les apps Veridian (Notifuse, Prospection, Analytics, CMS, futures).
> **Audience** : agents Claude (Hub + apps), reviewers humains, Robert.
> **Compagnons** :
> - `CONTRAT-HUB.md` — contrat technique d'intégration apps↔Hub
> - `CONTRAT-HUB-API-REF.md` — référence API exhaustive
> - `CLAUDE-ROOT.md` — instructions agents racine
>
> 🔥 **Règle absolue** : ce doc est la source de vérité pricing/trial.
> Si une app implémente quelque chose qui contredit ce doc, l'agent doit
> raise la contradiction avant d'agir (et NON le code après-coup).

---

## Sommaire

1. [Philosophie globale](#philosophie-globale)
2. [Grille de prix](#grille-de-prix)
3. [Flow trial complet](#flow-trial-complet)
4. [Responsabilités cross-app](#responsabilités-cross-app)
5. [Implémentations actuelles](#implémentations-actuelles)
6. [Interdits côté code](#interdits-côté-code)
7. [Maillage docs & tickets](#maillage-docs--tickets)

---

## Philosophie globale

**Générosité maximale, conversion par le temps.**

L'app ne doit **JAMAIS** être défigurée par des limites visibles ou des
murs béton. La conversion Free→Pro se fait par la **deadline 15 jours**
(le temps), pas par l'agacement (les limites de features).

**Why** :
- Une app utilisable séduit un client qui convertit parce qu'il l'aime
- Un mur béton frustre un client qui partira chez la concurrence
- Les seats illimités = growth hacking par invitation virale
- Le branding "Powered by Veridian" optionnel évite que les Free
  envoient des emails honteux à leurs destinataires (qui ne paient pas)

Cette décision a été actée par Robert le 2026-05-21 après un pivot
depuis une grille dimensionnelle initiale (500 contacts Free, 5000 Pro,
etc.) jugée trop agressive.

---

## Grille de prix

| Dimension | Free | Pro 29€ | Business 99€ | Enterprise |
|---|---|---|---|---|
| **Durée d'usage** | **15 jours** visibles puis paywall | illimité | illimité | illimité |
| Emails / mois | illimité (BYO) | illimité | illimité | illimité |
| Contacts en base | illimité | illimité | illimité | illimité |
| Comptes OAuth (BYO) | illimité | illimité | illimité | illimité |
| Automation sequences | illimité | illimité | illimité | illimité |
| Historique data | illimité | illimité | illimité | illimité |
| Seats invités | illimité | illimité | illimité | illimité |
| Domaines custom | illimité | illimité | illimité | illimité |
| A/B testing | ✅ | ✅ | ✅ | ✅ |
| **Branding "Powered by Veridian"** | ❌ optionnel | ❌ optionnel | ❌ + **white-label custom** | ❌ |

**SEULES différenciations réelles** :

1. **Durée Free 15j** — révélée seulement à J+2 après le 5ème mail
   envoyé. Avant : silence total côté UI.
2. **White-label custom** — Business+ peuvent mettre **leur propre
   footer** ("Sent by ClientName") au lieu de juste retirer "Powered
   by Veridian" en Pro.

**Note BYO sending** : Notifuse ne fournit pas de provider d'envoi.
Les clients connectent leur propre Gmail / Outlook / SES / SMTP. C'est
**leur provider qui limite**, pas nous. Mettre un cap email = paywall
artificiel sur un service qu'on n'offre pas. Cf. memory
`project_email_sending_strategy.md`.

---

## Flow trial complet

```
Phase 1 — Signup (J0)
  Tenant créé en free. Mode silence UI total.
  Le client peut TOUT faire (contacts, OAuth, A/B, automation,
  custom domains, seats — illimité partout). Aucun compteur,
  aucun bandeau, aucune deadline visible.

Phase 2 — Mode silence
  Tant que pas 5 mails envoyés : rien ne se passe.
  Le client peut rester ainsi indéfiniment (pas de timeout
  post-signup).

  À terme on relancera par email / leads qualifiés (futur,
  hors scope MVP).

Phase 3 — Activation silencieuse (5e mail envoyé)
  Au 5e mail : timer 2 jours démarre côté serveur.
  Aucune indication visible côté client.

Phase 4 — Révélation trial (J+2 après le 5e mail)
  Bandeau apparaît dans la console :
  "Tu es en essai gratuit Pro — il te reste 15 jours
  pour profiter de tout."

  Le client a déjà investi du temps + a déjà des résultats.
  Effet psychologique = "j'ai investi, je continue".

Phase 5 — Décision pendant les 15j

  Si CB ajoutée n'importe quand
    → CADEAU IMMÉDIAT DE 30 JOURS À PARTIR DU MOMENT OÙ
       CB AJOUTÉE (option A : 30j nets après ajout CB)
    → Le cadeau est INCONDITIONNEL : même si CB retirée
       après, on NE LUI RETIRE PAS les 30j bonus
    → Si CB encore présente à expiration des 30j
       → débit automatique Pro 29€/mois

  Sinon (rien fait pendant 15j)
    → À J+15 : paywall lecture seule
    → Lien "Réactiver" dans le bandeau

  Si upgrade direct sans attendre
    → Débit immédiat, plus de logique trial

Phase 6 — Cancel facile à tout moment
  1 clic dans Settings → confirmation → fini.
  Le client garde son accès jusqu'à fin de période payée
  (convention Stripe standard).

Phase 7 — Subscription Pro normale
  Facturation mensuelle classique. Cancel possible à tout
  moment depuis Settings.
```

**Pourquoi ce design est malin** :

1. **Avant 5 mails** = zéro pression → le sceptique a le temps de juger
2. **Entre 5 mails et J+2** = il investit en silence, prend des habitudes
3. **Bandeau à J+2** = il découvre qu'il a un trial → renversement
   psycho (l'urgence vient de lui, pas de nous)
4. **Cadeau 30j inconditionnel** = retire toute friction "et si
   j'enlève ma carte pour profiter ?" — on s'en fout, c'est gratuit
   pour nous
5. **Auto-débit à expiration** = par défaut il convertit, sauf s'il
   cancel activement

---

## Responsabilités cross-app

### Stripe (source de vérité paiement)
- Webhooks Stripe envoyés vers le **Hub uniquement** (pas vers les apps)
- Convention `metadata.app` sur chaque Subscription pour identifier
  l'app cible (notifuse / prospection / analytics / cms)
- Stripe Customer = 1 humain qui paie potentiellement N apps

### Hub (orchestrateur)
- Reçoit tous les webhooks Stripe (single endpoint)
- Mappe `stripe_customer_id` ↔ `user_id` ↔ tenants par app
- Dispatche `POST <app>/api/tenants/update-plan` aux apps concernées
- **Gère la state machine trial** (5 mails reçu webhook → wait 2j →
  activer trial → wait 15j ou +30j si CB → débit ou expiration)
- Dashboard MRR cross-app
- Notifications (email/Telegram à Robert) sur événements business

### Apps (Notifuse, Prospection, etc.)
- Endpoint `POST /api/tenants/update-plan` (déjà câblé Notifuse,
  Prospection, CMS)
- **Émettent les signaux d'engagement métier app-specific** :
  - Notifuse : webhook `tenant.activity_threshold_reached` au 5ème mail
  - Prospection : à définir (5 leads scrapés ?)
  - Analytics : à définir
  - CMS : peut-être pas applicable (pas un signal d'engagement clair)
- Consomment leur propre `/api/limits` pour gater paywall + UI
- **Ne traitent JAMAIS Stripe directement** — toute logique paiement
  passe par le Hub

### Frontière nette

| Qui | Quoi | Pas-quoi |
|---|---|---|
| Stripe | Paiement | N/A |
| Hub | Orchestration + trial state machine + Stripe | Détection d'activité métier |
| Apps | Signaux d'engagement + paywall local | Logique Stripe / state machine trial |

---

## Implémentations actuelles

### Notifuse — pivot pricing livré 2026-05-21

**Code** :
- Migration V37 : 9 colonnes `veridian_plan` (max_contacts, max_seats,
  feature_ab_testing, etc.) — **persistées** mais ne servent plus à
  bloquer
- `DefaultPlanLimits` : tout à `-1` / `true` partout, sauf
  `FeatureWhiteLabel` qui reste Business+
- `featureGatedPaths` : vide (revert lot 4a A/B testing gate)
- 47 unit tests verts + spec `@canary` qui sonde 3 tenants long-lived

**Détail dans** :
- `notifuse-veridian/CLAUDE.md` §"Vision pricing — actée 2026-05-21"
- `notifuse-veridian/todo/2026-05-20-pricing-plans-implementation.md`
- `notifuse-veridian/internal/domain/veridian.go` (`DefaultPlanLimits`)

**Endpoints exposés** :
- `GET /api/tenants/{id}/limits` — expose limites + features (HMAC Hub)
- `POST /api/tenants/provision` — provision (HMAC Hub)
- `POST /api/tenants/update-plan` — change plan (HMAC Hub)
- `POST /api/veridian/admin/grant-unlimited` — échappatoire admin

### Trial state machine — en attente côté Hub

**Tickets posés (non-implémentés)** :
- `veridian-hub/todo/2026-05-21-stripe-webhook-orchestrator.md` —
  Hub reçoit webhooks Stripe, dispatche update-plan vers apps
- `veridian-hub/todo/2026-05-21-trial-state-machine.md` — state
  machine 5 mails → wait 2j → trial 15j → +30j si CB → débit ou expire
- `notifuse-veridian/todo/2026-05-21-trial-eligible-signal.md` —
  Notifuse compte mails lifetime, émet webhook au seuil 5
- `notifuse-veridian/todo/2026-05-21-paywall-degraded-mode-soft-deleted.md`
  — UX paywall lecture seule à expiration trial

**Status** : tickets écrits le 2026-05-21, **en attente review et
implémentation** côté agent Hub. Notifuse n'a rien à faire tant que
le Hub n'a pas son endpoint webhook receiver.

### Autres apps — à propager

- **Prospection** : la même grille s'applique. Pivot pricing à
  documenter dans `veridian-prospection/CLAUDE.md` quand l'agent
  Prospection commencera la commercialisation
- **Analytics** : idem
- **CMS** : pricing géré différemment (B2B service Robert), pas en
  scope de ce doc

---

## Interdits côté code

Ces interdits s'appliquent à **toutes les apps** :

- ❌ Mur béton `402 Payment Required` sur une feature
- ❌ Compteur visible "il vous reste X mails / Y contacts / Y domaines"
- ❌ Menu A/B testing grisé "🔒 Pro" ou tout autre menu grisé
- ❌ Pop-up "passez Pro pour faire ça"
- ❌ Branding obligatoire qui dégrade les emails du client
- ❌ Toute limite enforced sur contacts / OAuth / seats / automation /
     historique / custom domains / A/B testing
- ❌ Affichage du timer trial AVANT J+2 (le délai 2j post-5mails doit
     rester INVISIBLE côté UI client)

## Acceptable côté code

- ✅ Bandeau trial visible UNIQUEMENT en phase 4+ (J+2 après 5 mails)
- ✅ Compte à rebours visible pendant les 15j (puis 30j si CB)
- ✅ Lien "Upgrade" pour ajouter CB
- ✅ Paywall lecture seule à expiration (mode dégradé)
- ✅ White-label custom = différenciation Business+ uniquement

---

## Maillage docs & tickets

### Source de vérité par sujet

| Sujet | Fichier source de vérité |
|---|---|
| Grille pricing + flow trial | **Ce doc** + `notifuse-veridian/CLAUDE.md` §Vision pricing |
| Contrat technique Hub↔apps | `veridian-hub/docs/CONTRAT-HUB.md` |
| Référence API exhaustive | `veridian-hub/docs/CONTRAT-HUB-API-REF.md` |
| BYO sending strategy | memory `project_email_sending_strategy.md` |
| Endpoint admin grant-unlimited | memory `project_grant_unlimited_endpoint.md` |
| Canary witness tenants | memory `project_canary_witness_tenants.md` |

### Tickets actifs

**Côté Notifuse** :
- `notifuse-veridian/todo/2026-05-20-pricing-plans-implementation.md` —
  ticket V37 (lots 1-3-4a-7 livrés, lots 4b/4c/4d/5/6 annulés post-pivot)
- `notifuse-veridian/todo/2026-05-21-trial-eligible-signal.md` —
  signal d'éligibilité 5 mails vers Hub
- `notifuse-veridian/todo/2026-05-21-paywall-degraded-mode-soft-deleted.md`
  — UX dégradée à l'expiration

**Côté Hub** :
- `veridian-hub/todo/2026-05-21-stripe-webhook-orchestrator.md` —
  endpoint webhook Stripe central
- `veridian-hub/todo/2026-05-21-trial-state-machine.md` — orchestration
  trial cross-app

### Memory utiles pour les agents

- `notifuse-veridian/memory/project_pricing_pivot_2026_05_21.md` —
  contexte complet du pivot (philosophie + grille + interdits + tickets)
- `notifuse-veridian/memory/project_pricing_plans_full.md` —
  **OBSOLÈTE 2026-05-21**, conservé pour mémoire (pointe vers le pivot)
- `notifuse-veridian/memory/project_email_sending_strategy.md` —
  pourquoi pas de cap email (BYO)
- `notifuse-veridian/memory/project_grant_unlimited_endpoint.md` —
  échappatoire admin pour passer un tenant en Enterprise lifetime

### CLAUDE.md liens vers ce doc

Les `CLAUDE.md` doivent référencer ce doc pour que les agents y
arrivent automatiquement quand ils touchent au pricing :

- ✅ `veridian-platform/CLAUDE.md` (racine) → ajouter section
  "Pricing & trial" pointant ici
- ✅ `notifuse-veridian/CLAUDE.md` → section "Vision pricing" déjà
  écrite (2026-05-21), à enrichir d'un pointeur vers ce doc
- ⏳ `veridian-hub/CLAUDE.md` → ajouter pointeur vers ce doc dans la
  section pricing/trial (quand l'agent Hub commence l'implémentation)
- ⏳ `veridian-prospection/CLAUDE.md` → idem quand la commercialisation
  Prospection démarre
- ⏳ `veridian-analytics/CLAUDE.md` → idem

---

## Changements

- **v1.0 (2026-05-21)** : création du doc, pivot pricing acté.
  Remplace l'ancienne grille dimensionnelle (Free 300mails/500contacts/
  1seat, Pro 10k/5k/5, Business 50k/25k/25) par la grille "tout
  illimité, paywall = durée".
